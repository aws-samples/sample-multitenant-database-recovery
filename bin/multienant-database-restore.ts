#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { DatabaseLevelRestoreStack } from '../lib/database-level-restore-stack'
import { AwsSolutionsChecks } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib';

const app = new cdk.App()

// Parse the selectedDatabases context
const selectedDatabase = app.node.tryGetContext('selectedDatabase') || 'AuroraServerless'
const ipAddress = app.node.tryGetContext('ipAddress');

// Environment for the stack
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION
}

// Deploy the main stack
new DatabaseLevelRestoreStack(app, 'DatabaseLevelRestoreStack', {
  env,
  selectedDatabase,
  ipAddress,
  description:
    'Database-level restore capability for multi-tenant databases with isolated tenant databases'
})

cdk.Tags.of(app).add('Stack', 'DatabaseLevelRestoreStack')

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))

app.synth()
