const builder = require('./api');
const exchanges = require('./exchanges');
const Handlers = require('./handlers');
const Intree = require('./intree');
const data = require('./data');
const Ajv = require('ajv');
const config = require('taskcluster-lib-config');
const monitorManager = require('./monitor');
const SchemaSet = require('taskcluster-lib-validate');
const loader = require('taskcluster-lib-loader');
const docs = require('taskcluster-lib-docs');
const App = require('taskcluster-lib-app');
const {sasCredentials} = require('taskcluster-lib-azure');
const githubAuth = require('./github-auth');
const {Client, pulseCredentials} = require('taskcluster-lib-pulse');

const load = loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => config({profile}),
  },

  monitor: {
    requires: ['process', 'profile', 'cfg'],
    setup: ({process, profile, cfg}) => monitorManager.setup({
      processName: process,
      verify: profile !== 'production',
      ...cfg.monitoring,
    }),
  },

  schemaset: {
    requires: ['cfg'],
    setup: ({cfg}) => new SchemaSet({
      serviceName: 'github',
      publish: cfg.app.publishMetaData,
      aws: cfg.aws,
    }),
  },

  reference: {
    requires: [],
    setup: () => exchanges.reference(),
  },

  ajv: {
    requires: [],
    setup: () => new Ajv(),
  },

  docs: {
    requires: ['cfg', 'schemaset', 'reference'],
    setup: ({cfg, schemaset, reference}) => docs.documenter({
      credentials: cfg.taskcluster.credentials,
      rootUrl: cfg.taskcluster.rootUrl,
      projectName: 'taskcluster-github',
      tier: 'integrations',
      schemaset: schemaset,
      publish: cfg.app.publishMetaData,
      references: [
        {name: 'api', reference: builder.reference()},
        {name: 'events', reference: reference},
        {name: 'logs', reference: monitorManager.reference()},
      ],
    }),
  },

  writeDocs: {
    requires: ['docs'],
    setup: ({docs}) => docs.write({docsDir: process.env['DOCS_OUTPUT_DIR']}),
  },

  pulseClient: {
    requires: ['cfg', 'monitor'],
    setup: ({cfg, monitor}) => {
      return new Client({
        namespace: cfg.pulse.namespace,
        monitor: monitor.monitor('pulse-client'),
        credentials: pulseCredentials(cfg.pulse),
      });
    },
  },

  publisher: {
    requires: ['cfg', 'schemaset', 'pulseClient'],
    setup: async ({cfg, pulseClient, schemaset}) => await exchanges.publisher({
      rootUrl: cfg.taskcluster.rootUrl,
      schemaset,
      client: pulseClient,
      publish: cfg.app.publishMetaData,
      aws: cfg.aws,
    }),
  },

  github: {
    requires: ['cfg'],
    setup: ({cfg}) => githubAuth({cfg}),
  },

  intree: {
    requires: ['cfg', 'schemaset'],
    setup: ({cfg, schemaset}) => Intree.setup({cfg, schemaset}),
  },

  Builds: {
    requires: ['cfg', 'monitor'],
    setup: async ({cfg, monitor}) => data.Builds.setup({
      tableName: cfg.app.buildsTableName,
      credentials: sasCredentials({
        accountId: cfg.azure.accountId,
        tableName: cfg.app.buildsTableName,
        rootUrl: cfg.taskcluster.rootUrl,
        credentials: cfg.taskcluster.credentials,
      }),
      monitor: monitor.monitor('table.builds'),
    }),
  },

  OwnersDirectory: {
    requires: ['cfg', 'monitor'],
    setup: async ({cfg, monitor}) => data.OwnersDirectory.setup({
      tableName: cfg.app.ownersDirectoryTableName,
      credentials: sasCredentials({
        accountId: cfg.azure.accountId,
        tableName: cfg.app.ownersDirectoryTableName,
        rootUrl: cfg.taskcluster.rootUrl,
        credentials: cfg.taskcluster.credentials,
      }),
      monitor: monitor.monitor('table.ownersdirectory'),
    }),
  },

  CheckRuns: {
    requires: ['cfg', 'monitor'],
    setup: async ({cfg, monitor}) => data.CheckRuns.setup({
      tableName: cfg.app.checkRunsTableName,
      credentials: sasCredentials({
        accountId: cfg.azure.accountId,
        tableName: cfg.app.checkRunsTableName,
        rootUrl: cfg.taskcluster.rootUrl,
        credentials: cfg.taskcluster.credentials,
      }),
      monitor: monitor.monitor('table.checkruns'),
    }),
  },

  ChecksToTasks: {
    requires: ['cfg', 'monitor'],
    setup: async ({cfg, monitor}) => data.ChecksToTasks.setup({
      tableName: cfg.app.checksToTasksTableName,
      credentials: sasCredentials({
        accountId: cfg.azure.accountId,
        tableName: cfg.app.checksToTasksTableName,
        rootUrl: cfg.taskcluster.rootUrl,
        credentials: cfg.taskcluster.credentials,
      }),
      monitor: monitor.monitor('table.checkstotasks'),
    }),
  },

  api: {
    requires: [
      'cfg', 'monitor', 'schemaset', 'github', 'publisher', 'Builds',
      'OwnersDirectory', 'ajv'],
    setup: ({cfg, monitor, schemaset, github, publisher, Builds,
      OwnersDirectory, ajv}) => builder.build({
      rootUrl: cfg.taskcluster.rootUrl,
      context: {
        publisher,
        cfg,
        github,
        Builds,
        OwnersDirectory,
        ajv,
        monitor: monitor.monitor('api-context'),
      },
      publish: cfg.app.publishMetaData,
      aws: cfg.aws,
      monitor: monitor.monitor('api'),
      schemaset,
    }),
  },

  server: {
    requires: ['cfg', 'api', 'docs'],
    setup: ({cfg, api, docs}) => App({
      port: cfg.server.port,
      env: cfg.server.env,
      forceSSL: cfg.server.forceSSL,
      trustProxy: cfg.server.trustProxy,
      apis: [api],
    }),
  },

  syncInstallations: {
    requires: ['github', 'OwnersDirectory', 'monitor'],
    setup: ({github, OwnersDirectory, monitor}) => {
      return monitor.monitor().oneShot('syncInstallations', async () => {
        const gh = await github.getAppGithub();
        const installations = (await gh.apps.getInstallations({})).data;
        await Promise.all(installations.map(inst => {
          return OwnersDirectory.create({
            installationId: inst.id,
            owner: inst.account.login,
          }, true);
        }));
      });
    },
  },

  handlers: {
    requires: [
      'cfg',
      'github',
      'monitor',
      'intree',
      'schemaset',
      'reference',
      'Builds',
      'pulseClient',
      'publisher',
      'CheckRuns',
      'ChecksToTasks',
    ],
    setup: async ({
      cfg,
      github,
      monitor,
      intree,
      schemaset,
      reference,
      Builds,
      pulseClient,
      publisher,
      CheckRuns,
      ChecksToTasks,
    }) =>
      new Handlers({
        rootUrl: cfg.taskcluster.rootUrl,
        credentials: cfg.pulse,
        monitor: monitor.monitor('handlers'),
        intree,
        reference,
        jobQueueName: cfg.app.jobQueue,
        deprecatedResultStatusQueueName: cfg.app.deprecatedResultStatusQueue,
        deprecatedInitialStatusQueueName: cfg.app.deprecatedInitialStatusQueue,
        resultStatusQueueName: cfg.app.resultStatusQueue,
        initialStatusQueueName: cfg.app.initialStatusQueue,
        context: {cfg, github, schemaset, Builds, CheckRuns, ChecksToTasks, publisher},
        pulseClient,
      }),
  },

  worker: {
    requires: ['handlers'],
    setup: async ({handlers}) => handlers.setup(),
  },
}, {
  profile: process.env.NODE_ENV,
  process: process.argv[2],
});

// If this file is executed launch component from first argument
if (!module.parent) {
  load.crashOnError(process.argv[2]);
}

module.exports = load;
