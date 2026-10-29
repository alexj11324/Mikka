#!/usr/bin/env node
// Validate the reviewed factory definition. Usage: node scripts/check-factory.mjs [path]
import { readFactoryConfig } from './factory-config.mjs'

const path = process.argv[2] ?? 'factory.yaml'
try {
  const { config, digest } = readFactoryConfig(path)
  console.log(`factory: ${config.name} (${config.repositories.length} repositories, ${config.runners?.length ?? 0} runners, digest ${digest})`)
} catch (error) {
  console.error(`factory config invalid: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
