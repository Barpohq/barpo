// Projects (project / workspace) — a named work directory.
//
// A project = a name plus a folder the platform creates. When a chat session
// is bound to a project the agent's tools run inside that folder, and every
// conversation of a project sees the same set of files.
//
// THE USER DOES NOT SUPPLY A PATH — only a name. If a path were accepted, the
// boundary of the agent's tools could end up pointing at `/` or `~`; the
// platform creates `~/.platforma/loyihalar/<slug>/` itself.
//
// DELETING a folder is not supported yet: whether the folder should be removed
// as well (and the confirmation flow that goes with it) is a separate step.

import { Hono } from 'hono'
import { createProjectDir, projectSlug } from '../work-dir.ts'
import { readProjects, projectByName, createProject } from '../repo.ts'

export const projectsRoutes = new Hono()

/** Name length limit — a practical bound both in the UI and in the folder name */
const NAME_MAX = 80

projectsRoutes.get('/projects', (c) => {
  return c.json({ projects: readProjects() })
})

projectsRoutes.post('/projects', async (c) => {
  let name: unknown
  try {
    const body = (await c.req.json()) as { name?: unknown }
    name = body?.name
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400)
  }

  if (typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ error: 'Project name is required' }, 400)
  }
  const clean = name.trim()
  if (clean.length > NAME_MAX) {
    return c.json({ error: `Project name must not exceed ${NAME_MAX} characters` }, 400)
  }

  // The folder name is built only from safe characters. If it comes out empty
  // the name consists entirely of characters unusable in a folder name (only
  // emoji, or cyrillic, for instance). We do not fall back to a generated
  // name: two different projects would then end up sharing one folder.
  const slug = projectSlug(clean)
  if (!slug) {
    return c.json(
      {
        error: 'Could not derive a folder name from the project name',
        detail: 'The name needs at least one latin letter or digit',
      },
      400,
    )
  }

  if (projectByName(clean)) {
    return c.json(
      { error: 'A project with this name already exists', detail: clean },
      409,
    )
  }

  // The folder is created first: if the file system fails (no permission, disk
  // full) we must not leave a "project without a folder" row in the database.
  let folder: string
  try {
    folder = createProjectDir(slug)
  } catch (error) {
    return c.json(
      {
        error: 'Could not create the project folder',
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    )
  }

  // The UNIQUE index — even after the `projectByName` check there can be a
  // race (two requests at once). The guarantee at the database layer is the
  // real one; the check above only exists to produce a nicer error.
  try {
    return c.json({ project: createProject(clean, folder) }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('UNIQUE')) {
      return c.json({ error: 'A project with this name already exists', detail: clean }, 409)
    }
    throw error
  }
})
