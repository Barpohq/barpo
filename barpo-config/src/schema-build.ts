// Builds a JSON Schema from `FIELDS`.
//
// Why it is needed:
//   1) editors (VS Code) use `$schema` to give autocompletion and error
//      marking — the user does not go astray writing the config;
//   2) later the web UI builds the form from that same schema — adding a
//      field updates the form by itself, with no separate UI code.
//
// The schema is never written by hand, it is always generated from
// `FIELDS`: keeping the two in sync manually would inevitably drift.

import { FIELDS, type FieldSpec } from './schema.ts'

/** The minimal shape of a JSON Schema node — just the part we need */
interface SchemaNode {
  type?: string | string[]
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  enum?: readonly string[]
  items?: SchemaNode
  properties?: Record<string, SchemaNode>
  additionalProperties?: boolean
}

/** Turns a single field spec into a JSON Schema node */
function fieldNode(spec: FieldSpec): SchemaNode {
  const node: SchemaNode = {
    description: spec.hint,
    default: spec.default,
  }

  switch (spec.kind) {
    case 'number':
      node.type = 'number'
      if (spec.range?.min !== undefined) node.minimum = spec.range.min
      if (spec.range?.max !== undefined) node.maximum = spec.range.max
      break
    case 'boolean':
      node.type = 'boolean'
      break
    case 'text':
      node.type = 'string'
      break
    case 'select':
      node.type = 'string'
      node.enum = spec.options
      break
    case 'stringList':
      node.type = 'array'
      node.items = { type: 'string' }
      break
  }

  // Fields that allow `null` get two types
  if (spec.nullable && typeof node.type === 'string') {
    node.type = [node.type, 'null']
  }

  return node
}

/**
 * Builds the full JSON Schema.
 *
 * `additionalProperties: false` is deliberate: a typo (`enabeld`) should
 * show up in the editor right away instead of being silently ignored.
 */
export function buildSchema(): Record<string, unknown> {
  const root: SchemaNode = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }

  for (const spec of FIELDS) {
    const parts = spec.path.split('.')
    let current = root

    // Create the intermediate objects: agent → compaction → enabled
    for (const part of parts.slice(0, -1)) {
      current.properties ??= {}
      const existing = current.properties[part]
      if (existing) {
        current = existing
        continue
      }
      const created: SchemaNode = { type: 'object', properties: {}, additionalProperties: false }
      current.properties[part] = created
      current = created
    }

    current.properties ??= {}
    current.properties[parts.at(-1)!] = fieldNode(spec)
  }

  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    title: 'Platform settings',
    description:
      'Settings for the platform AI agent, its tools and the permission system. ' +
      'This file is generated — do not edit it by hand, ' +
      'change barpo-config/src/schema.ts instead.',
    // `$schema` is written in the config file too — allow it so it is not
    // counted as an unknown field
    properties: { $schema: { type: 'string' }, ...(root.properties ?? {}) },
    type: 'object',
    additionalProperties: false,
  }
}
