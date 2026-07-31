// The mode manager — the fallback mechanism.
//
// Auto mode turns off in three cases: the classifier is broken, 3 blocks in a
// row, 20 blocks in total. Once off it does not restore itself automatically.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  TOTAL_BLOCK_LIMIT,
  CONSECUTIVE_BLOCK_LIMIT,
  ModeManager,
  modeManager,
  closeModeManager,
  clearModes,
  type ModeChange,
} from '../src/mode.ts'

afterEach(() => {
  clearModes()
})

describe('initial state', () => {
  test('the default mode is confirm', () => {
    const m = new ModeManager('s1')
    expect(m.mode).toBe('confirm')
    expect(m.reason).toBeUndefined()
  })

  test('blocks are not counted in confirm mode', () => {
    const m = new ModeManager('s1')
    m.blocked()
    m.blocked()
    m.blocked()
    expect(m.mode).toBe('confirm')
    expect(m.counters.consecutive).toBe(0)
  })
})

describe('switching modes', () => {
  test('switching to auto notifies the listener', () => {
    const m = new ModeManager('s1')
    const received: ModeChange[] = []
    m.subscribe((c) => received.push(c))

    m.set('auto')
    expect(m.mode).toBe('auto')
    expect(received).toHaveLength(1)
    expect(received[0]?.mode).toBe('auto')
  })

  test('setting the same mode again does not notify', () => {
    const m = new ModeManager('s1')
    m.set('auto')
    const received: ModeChange[] = []
    m.subscribe((c) => received.push(c))
    m.set('auto')
    expect(received).toHaveLength(0)
  })

  test('going back to auto clears the counters', () => {
    const m = new ModeManager('s1')
    m.set('auto')
    m.blocked()
    m.blocked()
    expect(m.counters.total).toBe(2)

    m.set('confirm')
    m.set('auto')
    expect(m.counters).toEqual({ consecutive: 0, total: 0 })
  })
})

describe('the consecutive block limit', () => {
  test(`${CONSECUTIVE_BLOCK_LIMIT} blocks in a row turn auto off`, () => {
    const m = new ModeManager('s1')
    m.set('auto')

    for (let i = 1; i < CONSECUTIVE_BLOCK_LIMIT; i += 1) {
      expect(m.blocked()).toBe(false)
      expect(m.mode).toBe('auto')
    }
    expect(m.blocked()).toBe(true)
    expect(m.mode).toBe('confirm')
    expect(m.reason).toContain('in a row')
  })

  test('an allow resets the consecutive counter to zero', () => {
    const m = new ModeManager('s1')
    m.set('auto')

    m.blocked()
    m.blocked()
    m.allowed()
    expect(m.counters.consecutive).toBe(0)

    // Now 3 more are needed
    m.blocked()
    m.blocked()
    expect(m.mode).toBe('auto')
    m.blocked()
    expect(m.mode).toBe('confirm')
  })

  test('an allow does not clear the total counter', () => {
    const m = new ModeManager('s1')
    m.set('auto')
    m.blocked()
    m.allowed()
    expect(m.counters.total).toBe(1)
  })
})

describe('the total block limit', () => {
  test(`${TOTAL_BLOCK_LIMIT} blocks in total turn auto off`, () => {
    const m = new ModeManager('s1')
    m.set('auto')

    // An allow after every block — so the consecutive limit does not fire
    for (let i = 0; i < TOTAL_BLOCK_LIMIT - 1; i += 1) {
      m.blocked()
      m.allowed()
    }
    expect(m.mode).toBe('auto')

    m.blocked()
    expect(m.mode).toBe('confirm')
    expect(m.reason).toContain('in total')
  })
})

describe('classifier failure', () => {
  test('auto turns off immediately', () => {
    const m = new ModeManager('s1')
    m.set('auto')
    m.classifierFailed('no model found')

    expect(m.mode).toBe('confirm')
    expect(m.reason).toContain('no model found')
  })

  test('it has no effect in confirm mode', () => {
    const m = new ModeManager('s1')
    m.classifierFailed('error')
    expect(m.reason).toBeUndefined()
  })

  test('once off it does not restore itself automatically', () => {
    const m = new ModeManager('s1')
    m.set('auto')
    m.classifierFailed('timeout')

    // Neither the passing of time nor a successful action brings the mode back
    m.allowed()
    expect(m.mode).toBe('confirm')

    // Only by hand
    m.set('auto')
    expect(m.mode).toBe('auto')
    expect(m.reason).toBeUndefined()
  })
})

describe('registry', () => {
  test('one manager per session', () => {
    expect(modeManager('s1')).toBe(modeManager('s1'))
  })

  test('sessions are isolated', () => {
    modeManager('s1').set('auto')
    expect(modeManager('s2').mode).toBe('confirm')
  })

  test('a new manager after closing', () => {
    const a = modeManager('s1')
    a.set('auto')
    closeModeManager('s1')
    expect(modeManager('s1').mode).toBe('confirm')
  })
})
