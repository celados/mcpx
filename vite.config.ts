import { harness, ignore } from '@celados/harness'
import { defineConfig } from 'vite-plus'

export default defineConfig({ ...harness(ignore('dist-bun/**')) })
