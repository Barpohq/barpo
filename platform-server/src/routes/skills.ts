// Skill do'koni — Skills.tsx sahifasi uchun.
// Keyingi bosqich: POST /api/skills/:id/install (ruxsat modali tasdig'i bilan).

import { Hono } from 'hono'
import { skilllarOqi } from '../repo.ts'

export const skillsRoutes = new Hono()

skillsRoutes.get('/skills', (c) => {
  return c.json({ skills: skilllarOqi() })
})
