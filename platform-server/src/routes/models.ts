// Available AI models — the model picker fetches this list when a chat starts.
//
// The list is assembled from the providers detected on the user's own machine:
// environment variables, a local Ollama and the ~/.claude / ~/.codex
// subscriptions. The detection result is cached — /models/refresh reloads it.

import { detectModels } from '@platforma/ai'
import { Hono } from 'hono'
import { auditWrite } from '../audit.ts'

export const modelsRoutes = new Hono()

modelsRoutes.get('/models', async (c) => {
  const result = await detectModels()
  return c.json({
    models: result.models,
    providers: result.providers,
    warnings: result.warnings,
    time: result.time,
  })
})

modelsRoutes.post('/models/refresh', async (c) => {
  const result = await detectModels({ force: true })
  auditWrite(
    'platform',
    'AI providers re-detected',
    `${result.providers.length} provider · ${result.models.length} model`,
    'read',
    'OK',
  )
  return c.json({
    models: result.models,
    providers: result.providers,
    warnings: result.warnings,
    time: result.time,
  })
})
