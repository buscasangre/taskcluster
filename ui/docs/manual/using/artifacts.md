---
filename: using/artifacts.md
title: Working With Artifacts
order: 60
---

# Working with Artifacts

## Creating Artifacts

Most workers automatically produce a `public/logs/live.log` artifact containing
the main log of the artifact.

Workers also generally provide a way to specify, in the task description, the
files and directories that should be uploaded as artifacts after the task
completes. For a worker running
[Generic-Worker](/docs/reference/workers/generic-worker/docs/payload) or
[Taskcluster-Worker](https://github.com/taskcluster/taskcluster-worker/blob/master/plugins/artifacts/payloadschema.go), that looks like:

```yaml
artifacts:
  - name: public/results
    path: workspace/results
    type: directory
```

Tor a worker running
[Docker-Worker](/docs/reference/workers/docker-worker/docs/payload), the format is
slightly different:

```yaml
artifacts:
  public/results:
    path: /home/user/workspace/results
    type: directory
```

In either case will upload all files in the `workspace/results` directory as
artifacts named `public/results/<filename>`. Note that Docker-Worker requires
an absolute path, while Generic-Worker requires a relative path, and for
Taskcluster-Worker the path format depends on the engine in use.

It is also possible, although unusual, to create artifacts using the [Queue
API](/docs/reference/platform/taskcluster-queue/references/api#createArtifact).

## Passing Artifacts Between Tasks

Suppose you are creating a task graph with task B depending on task A, where
task B requires an artifact from task A. For example, task A might build an
application, with task B running tests on the built product.

In this case, task B should list task A in its `dependencies` property so that
it does not begin until that task is complete. It should then download the
resulting artifact on task A using a URL to the
[Queue.getLatestArtifact](/docs/reference/platform/taskcluster-queue/references/api#getLatestArtifact)
endpoint. That will generally look like this:

    https://queue.taskcluster.net/v1/task/URFDBjl5RtSNz_NJEH3hlw/artifacts/public/build.zip

where `URFDBjl5RtSNz_NJEH3hlw` is the taskId assigned to task A. This URL can
be calculated before the task runs - for example, by a decision task.  The URL
comes with all the cautions about client robustness in the
[Artifacts](/docs/manual/tasks/artifacts) section, above.

## Finding the Latest Build

A very common case is to provide a stable link to the most recent build of a
repository. Suppose that the Amazing Cats build process produces an artifact
named `public/Amazing-Cats.dmg`, and you wish to create a URL that will always
point to the most recent DMG.

The index path for this build will be `project.amazingcats.builds.latest`. Add
a route to the task with the prefix `index.`:

```yaml
routes:
 - index.project.amazingcats.builds.latest
```

This will require a scope when creating the task. Add
`queue:route:index.project.amazingcats.*`, to the Github repo role
`repo:github.com/amazing/*` to ensure that the service creating the task
(Taskcluster-Github) has this scope.

With this change, each *successful* build task will be indexed at the selected
path. You can find the task through the index browser in the tools site, and
find the DMG in the artifacts of the latest run

The Index service provides a convenient `index.findArtifactFromTask` method
that will do all of that in one go, redirecting to the artifact itself. For
public artifacts, the method requires no authentication, so it can be called by
any sufficiently robust HTTP client. Based on the documentation for the
service, we can construct a URL to the artifact:
`https://index.taskcluster.net/task/project.amazingcats.builds.latest/artifacts/Amazing-Cats.dmg`.

This link could be embedded in the Amazing Cats README or documentation site
for download.

_Note:_ A path like this might point to a new task at any moment. While it is
safe to download a single artifact like this, if your use-case involves
downloading a collection of related artifacts, it may be problematic. Suppose
the Linux version of Amazing-Cats contains both an executable binary and an
associated file containing debug symbols. Downloading those two files via the
index path may result in binary and symbols from different tasks if a task
completes during the download process.

There are two ways to avoid this issue. The simplest is to bundle all important
results into a single artifact, but for large artifacts this can be wasteful.
The more complex option is to script use of the `index.findTask` method to
determine the latest task ID, then download all artifacts from that single task
using `queue.getLatestArtifact`.
