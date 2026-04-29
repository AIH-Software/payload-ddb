import type { DatabaseAdapterObj, Payload } from 'payload'

import { createDatabaseAdapter } from 'payload'

import type { Args, DynamoAdapter } from './types.js'

import { connect } from './connect.js'
import { count } from './count.js'
import { countGlobalVersions } from './countGlobalVersions.js'
import { countVersions } from './countVersions.js'
import { create } from './create.js'
import { createGlobal } from './createGlobal.js'
import { createGlobalVersion } from './createGlobalVersion.js'
import { createVersion } from './createVersion.js'
import { deleteMany } from './deleteMany.js'
import { deleteOne } from './deleteOne.js'
import { deleteVersions } from './deleteVersions.js'
import { destroy } from './destroy.js'
import { find } from './find.js'
import { findDistinct } from './findDistinct.js'
import { findGlobal } from './findGlobal.js'
import { findGlobalVersions } from './findGlobalVersions.js'
import { findOne } from './findOne.js'
import { findVersions } from './findVersions.js'
import { init } from './init.js'
import { queryDrafts } from './queryDrafts.js'
import { updateGlobal } from './updateGlobal.js'
import { updateGlobalVersion } from './updateGlobalVersion.js'
import { updateMany } from './updateMany.js'
import { updateOne } from './updateOne.js'
import { updateVersion } from './updateVersion.js'
import { upsert } from './upsert.js'

export type { Args, DynamoAdapter } from './types.js'

const NAME = 'dynamodb'
const PACKAGE_NAME = '@aih-pkg/payload-ddb'
const DEFAULT_TABLE_NAME = 'payload'

export function dynamoAdapter(args: Args = {}): DatabaseAdapterObj<DynamoAdapter> {
  function adapterInit({ payload }: { payload: Payload }): DynamoAdapter {
    const tableName = args.tableName ?? DEFAULT_TABLE_NAME

    const resolvePartition = (slug: string): string => slug
    const resolveVersionsPartition = (slug: string): string => `${slug}_versions`

    return createDatabaseAdapter<DynamoAdapter>({
      name: NAME,
      packageName: PACKAGE_NAME,
      defaultIDType: 'text',
      payload,

      // ----- adapter-specific state -----
      clientConfig: args.clientConfig ?? {},
      translateConfig: args.translateConfig ?? {
        marshallOptions: {
          removeUndefinedValues: true,
          convertClassInstanceToMap: true,
        },
      },
      client: args.client,
      docClient: undefined,
      ownsClient: !args.client,
      tableName,
      ensureTables: args.ensureTables ?? false,
      resolvePartition,
      resolveVersionsPartition,

      // ----- lifecycle -----
      connect,
      destroy,
      init,

      // ----- transactions (no-op until DynamoDB transact-writes are wired) -----
      beginTransaction: async () => null,
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},

      // ----- methods -----
      count,
      countGlobalVersions,
      countVersions,
      create,
      createGlobal,
      createGlobalVersion,
      createVersion,
      deleteMany,
      deleteOne,
      deleteVersions,
      find,
      findDistinct,
      findGlobal,
      findGlobalVersions,
      findOne,
      findVersions,
      queryDrafts,
      updateGlobal,
      updateGlobalVersion,
      updateMany,
      updateOne,
      updateVersion,
      upsert,
    })
  }

  return {
    name: NAME,
    defaultIDType: 'text',
    init: adapterInit,
  }
}
