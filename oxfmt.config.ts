import { tanstackConfig } from '@tanstack/oxfmt-config'
import { defineConfig } from 'oxfmt'

export default defineConfig({
  ...tanstackConfig,
  ignorePatterns: [
    ...tanstackConfig.ignorePatterns,
    // Custom ignore patterns go here
  ],
  singleAttributePerLine: true
})