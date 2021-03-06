// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import Octokit from '@octokit/rest'
import { Context, Logger } from 'probot'
// tslint:disable-next-line:no-submodule-imports
import { GitHubAPI } from 'probot/lib/github'

import { IssueComment } from 'github-webhook-event-types'
import { BuildInfo, GetJobOutputFunc, JobInfo, StatusInfo } from './ci'

export class GitHub {
  public static async deleteComment (context: Context, issueComment: IssueComment) {
    const repo = issueComment.repository
    try {
      await context.github.issues.deleteComment({
        comment_id: issueComment.comment.id.toString(),
        owner: repo.owner.login,
        repo: repo.name
      })
    } catch (e) {
      context.log.error(
        e,
        `Error occurred deleting rescan comment for PR ${issueComment.issue.number} in ${
          repo.full_name
        }`
      )
    }
  }

  public static async getLatestTravisStatus (
    context: Context,
    issueComment: IssueComment
  ): Promise<StatusInfo | undefined> {
    const repo = issueComment.repository
    try {
      const pr = (await context.github.pullRequests.get({
        number: issueComment.issue.number,
        owner: repo.owner.login,
        repo: repo.name
      })).data

      if (!pr.head) {
        return undefined
      }

      let travisStatus: Octokit.GetStatusesResponseItem | undefined
      await context.github.paginate(
        context.github.repos.getStatuses({
          owner: repo.owner.login,
          per_page: 100,
          ref: pr.head.sha,
          repo: repo.name
        }),
        ((res: Octokit.Response<Octokit.GetStatusesResponse>, done: () => void) => {
          for (const status of res.data) {
            if (status.context === 'continuous-integration/travis-ci/pr') {
              travisStatus = status
              done()
              break
            }
          }
        }) as any // Type information for this parameter is wrong :(
      )

      if (!travisStatus) {
        return undefined
      }

      return {
        repository: repo,
        sha: pr.head.sha,
        target_url: travisStatus.target_url
      }
    } catch (e) {
      context.log.error(
        e,
        `Error occurred fetching latest Travis status for PR ${issueComment.issue.number} in ${
          repo.full_name
        }`
      )
      return undefined
    }
  }

  private static readonly FINISHED_STATES = ['passed', 'failed', 'errored', 'canceled']

  private readonly appId: number
  private readonly buildInfo: BuildInfo
  private readonly client: GitHubAPI
  private readonly getJobOutput: GetJobOutputFunc
  private readonly log: Logger

  public constructor (
    appId: number,
    context: Context,
    buildInfo: BuildInfo,
    getJobOutput: GetJobOutputFunc
  ) {
    this.appId = appId
    this.buildInfo = buildInfo
    this.client = context.github
    this.getJobOutput = getJobOutput
    this.log = context.log
  }

  public async checksToCreate (newJobs: ReadonlyArray<JobInfo>): Promise<ReadonlyArray<JobInfo>> {
    const create: JobInfo[] = []

    const existingChecks = await this.getExistingChecks()
    for (const current of newJobs) {
      const existing = existingChecks.find(c => this.isCheckForJob(c, current))
      if (
        !existing ||
        this.getStatus(current) !== existing.status ||
        current.name !== existing.name
      ) {
        create.push(current)
      }
    }

    return create
  }

  public async createCheck (jobInfo: JobInfo): Promise<string | undefined> {
    const payload = this.getChecksCreateParams(jobInfo)
    if (payload.status === 'completed') {
      await this.addCompletionInfo(payload, jobInfo)
    }

    this.log.debug(`Creating check for job ${jobInfo.jobId}`, payload)
    try {
      const result = await this.client.checks.create(payload)
      const checkRunId = result.data.id.toString()
      this.log.debug(`Check ${checkRunId} created for job ${jobInfo.jobId}`)
      return checkRunId
    } catch (e) {
      this.log.error(e, `Error occurred creating check for job ${jobInfo.jobId}`)
      return undefined
    }
  }

  private async getExistingChecks (): Promise<
    ReadonlyArray<Octokit.ListForRefResponseCheckRunsItem>
  > {
    this.log.debug(`Fetching existing checks for build ${this.buildInfo.id}`)
    try {
      const myChecks: ReadonlyArray<
        Octokit.ListForRefResponseCheckRunsItem
      > = await this.client.paginate(
        this.client.checks.listForRef({
          owner: this.buildInfo.owner,
          per_page: 100,
          ref: this.buildInfo.headSha,
          repo: this.buildInfo.repo
        }),
        (res: Octokit.Response<Octokit.ListForRefResponse>) => {
          return res.data.check_runs.filter(c => c.app.id === this.appId)
        }
      )

      this.log.debug(`Fetched ${myChecks.length} existing checks for build ${this.buildInfo.id}`)
      return myChecks
    } catch (e) {
      this.log.error(e, `Error occurred fetching existing checks for build ${this.buildInfo.id}`)
      return []
    }
  }

  private isCheckForJob (c: Octokit.ListForRefResponseCheckRunsItem, j: JobInfo): boolean {
    if (!c.external_id) {
      return false
    }
    const [domain, buildId, jobId] = c.external_id.split('/')
    return this.buildInfo.domain === domain && this.buildInfo.id === buildId && j.jobId === jobId
  }

  private getChecksCreateParams (jobInfo: JobInfo): Octokit.ChecksCreateParams {
    return {
      details_url: jobInfo.url,
      external_id: `${this.buildInfo.domain}/${this.buildInfo.id}/${jobInfo.jobId}`,
      head_sha: this.buildInfo.headSha,
      name: jobInfo.name,
      owner: this.buildInfo.owner,
      repo: this.buildInfo.repo,
      started_at: jobInfo.startedAt,
      status: this.getStatus(jobInfo)
    }
  }

  private async addCompletionInfo (
    payload: Octokit.ChecksCreateParams,
    jobInfo: JobInfo
  ): Promise<void> {
    payload.conclusion = this.getConclusion(jobInfo)
    payload.completed_at = jobInfo.finishedAt

    if (payload.conclusion === 'cancelled') {
      return
    }

    try {
      const output = await this.getJobOutput(jobInfo)
      if (output) {
        payload.output = output as Octokit.ChecksCreateParamsOutput
      }
    } catch (e) {
      this.log.error(
        e,
        `Error occurred while getting job output for job ${jobInfo.jobId}, output will be skipped`
      )
    }
  }

  private getStatus (jobInfo: JobInfo) {
    if (GitHub.FINISHED_STATES.includes(jobInfo.state)) {
      return 'completed'
    } else if (jobInfo.state === 'started') {
      return 'in_progress'
    } else {
      return 'queued'
    }
  }

  private getConclusion (jobInfo: JobInfo) {
    if (jobInfo.state === 'passed') {
      return 'success'
    } else if (jobInfo.state === 'failed' && !jobInfo.ignoreFailure) {
      return 'failure'
    } else if (jobInfo.state === 'canceled') {
      return 'cancelled'
    } else {
      return 'neutral'
    }
  }
}
