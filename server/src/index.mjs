import { createApp } from './http.mjs'
import { loadRuntime } from './runtime.mjs'

const { config, service } = loadRuntime()
if (config.plans.length === 0) console.warn('No plan has a price yet: set PLAN_* in .env. Activation stays unavailable until then.')

const server = createApp(service, { trustProxy: config.trustProxy, onError: (error) => console.error('Request failed:', error?.message) })
server.listen(config.port, config.host, () => console.log(`X Auto activation server on ${config.host}:${config.port}`))
