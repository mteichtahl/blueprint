import { resolve } from 'node:path';
import { App } from 'aws-cdk-lib';
import { loadConfig } from '@bmg/config';
import { buildApp } from '../lib/app.ts';

// BMG_CONFIG lets CI synthesize against bmg.config.example.json before
// `bmg init` has committed the real (non-secret) bmg.config.json.
const configFile = resolve(
  import.meta.dirname,
  '..',
  '..',
  process.env.BMG_CONFIG ?? 'bmg.config.json',
);
const cfg = loadConfig(configFile);

const app = new App();
const skip = {
  guardDuty: app.node.tryGetContext('bmg:skipGuardDuty') === 'true',
  securityHub: app.node.tryGetContext('bmg:skipSecurityHub') === 'true',
  config: app.node.tryGetContext('bmg:skipConfig') === 'true',
  accessAnalyzer: app.node.tryGetContext('bmg:skipAccessAnalyzer') === 'true',
};
buildApp(app, cfg, { skip, version: process.env.BMG_VERSION ?? process.env.GITHUB_SHA ?? 'local' });
app.synth();
