#!/usr/bin/env bun
import { runDaemonServer } from './daemon-server'
import { runMcpx } from './router'

const argv = process.argv.slice(2)
if (argv[0] === '@daemon.server') {
	await runDaemonServer()
} else {
	await runMcpx(argv, process.cwd(), import.meta.path)
}
