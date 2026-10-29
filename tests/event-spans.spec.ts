import { expect, test, type Locator, type Page } from '@playwright/test'
import { createDemoSnapshot } from '../src/data/fixtures'
import type { CalendarEvent, CalendarView, Theme } from '../src/domain/types'

const timeZone = 'America/Chicago'
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'retreat',
  accountId: 'personal',
  calendarId: 'personal',
  title: 'Autumn retreat',
  start: '2026-10-30',
  end: '2026-11-03',
  allDay: true,
  timeZone,
  ...overrides,
})
const sampleEvents = [
  event(),
  event({
    id: 'conference',
    title: 'Design conference',
    allDay: false,
    start: '2026-10-26T14:00:00Z',
    end: '2026-10-28T16:00:00Z',
  }),
  event({
    id: 'community',
    calendarId: 'family',
    title: 'Community day',
    start: '2026-10-27',
    end: '2026-10-28',
  }),
  event({
    id: 'overnight',
    title: 'Overnight train',
    allDay: false,
    start: '2026-10-27T04:00:00Z',
    end: '2026-10-27T07:00:00Z',
  }),
  event({
    id: 'exact-day',
    title: 'A full day',
    allDay: false,
    start: '2026-10-28T16:00:00Z',
    end: '2026-10-29T16:00:00Z',
  }),
]

async function seed(page: Page, view: CalendarView, events = sampleEvents, theme: Theme = 'light') {
  const snapshot = createDemoSnapshot('2026-10-26', timeZone)
  snapshot.events = events
  await page.clock.install({ time: new Date('2026-10-26T17:00:00Z') })
  await page.addInitScript(
    ({ snapshot, view, theme, timeZone }) => {
      localStorage.setItem('calendar-demo-v1', JSON.stringify(snapshot))
      localStorage.setItem(
        'multi-calendar-preferences-v1',
        JSON.stringify({ state: { view, theme, timeZone }, version: 0 }),
      )
    },
    { snapshot, view, theme, timeZone },
  )
  await page.goto('/')
}

async function expectContinuousBar(bar: Locator, first: Locator, last: Locator) {
  const start = (await first.boundingBox())!
  const end = (await last.boundingBox())!
  const bounds = (await bar.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(start.x - 1)
  expect(bounds.x).toBeLessThan(start.x + 6)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(end.x + end.width + 1)
  expect(bounds.x + bounds.width).toBeGreaterThan(end.x + end.width - 6)
  // The same button must cover the interior, including every intervening day border.
  expect(
    await bar.evaluate((button) => {
      const bounds = button.getBoundingClientRect()
      return Array.from({ length: 20 }, (_, index) => {
        const hit = document.elementFromPoint(
          bounds.x + (bounds.width * (index + 0.5)) / 20,
          bounds.y + bounds.height / 2,
        )
        return hit && button.contains(hit)
      }).every(Boolean)
    }),
  ).toBe(true)
}

for (const theme of ['light', 'dark'] as const) {
  test(`month bars wrap continuously and remain interactive in ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await seed(page, 'month', sampleEvents, theme)
    const month = page.getByRole('region', { name: 'Month calendar', exact: true })
    await expect(month.locator('.month-day')).toHaveCount(42)
    const retreat = month.locator('.month-event[data-event-id="retreat"]')
    await expect(retreat).toHaveCount(2)
    await expect(retreat.first()).toHaveClass(/continues-after/)
    await expect(retreat.last()).toHaveClass(/continues-before/)
    await expectContinuousBar(
      retreat.first(),
      month.locator('[data-date="2026-10-30"]'),
      month.locator('[data-date="2026-10-31"]'),
    )
    await expectContinuousBar(
      retreat.last(),
      month.locator('[data-date="2026-11-01"]'),
      month.locator('[data-date="2026-11-02"]'),
    )
    await expect(retreat.first()).toHaveCSS('border-top-right-radius', '0px')
    await expect(retreat.last()).toHaveCSS('border-top-left-radius', '0px')
    await expect(retreat.first()).toHaveCSS('background-color', 'rgb(26, 115, 232)')

    const conference = month.locator('.month-event[data-event-id="conference"]')
    await expect(conference).toHaveCount(1)
    await expect(conference).toHaveClass(/is-spanning/)
    await expect(conference).toContainText('9am')
    await expect(conference).toContainText('11am')
    await expectContinuousBar(
      conference,
      month.locator('[data-date="2026-10-26"]'),
      month.locator('[data-date="2026-10-28"]'),
    )
    await expect(month.locator('.month-event[data-event-id="overnight"]')).toHaveCount(2)
    await expect(month.locator('.month-event[data-event-id="exact-day"]')).toHaveCount(2)
    await expect(month.locator('.is-spanning[data-event-id="exact-day"]')).toHaveCount(0)

    await conference.focus()
    await page.keyboard.press('Enter')
    const details = page.getByRole('dialog', { name: 'Design conference', exact: true })
    await expect(details).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(details).not.toBeVisible()
    const bounds = (await retreat.first().boundingBox())!
    await retreat.first().click({ position: { x: bounds.width - 12, y: bounds.height / 2 } })
    await expect(page.getByRole('dialog', { name: 'Autumn retreat', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    const path = testInfo.outputPath(`month-spans-${theme}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`Month spans (${theme})`, { path, contentType: 'image/png' })
  })
}

for (const [view, name] of [
  ['week', 'Week'],
  ['7days', '7 days'],
] as const) {
  test(`${name} shows long timed events only as continuous bars`, async ({ page }, testInfo) => {
    await seed(page, view)
    const calendar = page.getByRole('region', { name: `${name} calendar`, exact: true })
    const conference = calendar.locator('.all-day-event[data-event-id="conference"]')
    await expect(conference).toHaveCount(1)
    await expect(calendar.locator('.timed-event[data-event-id="conference"]')).toHaveCount(0)
    await expect(calendar.locator('.timed-event[data-event-id="overnight"]')).toHaveCount(2)
    await expect(calendar.locator('.timed-event[data-event-id="exact-day"]')).toHaveCount(2)
    await expect(conference).toHaveAccessibleName(
      'Design conference, Monday, October 26, 2026 at 9:00 AM to Wednesday, October 28, 2026 at 11:00 AM',
    )
    await expectContinuousBar(
      conference,
      calendar.getByRole('button', { name: 'View Monday, October 26, 2026', exact: true }),
      calendar.getByRole('button', { name: 'View Wednesday, October 28, 2026', exact: true }),
    )
    const community = calendar.locator('.all-day-event[data-event-id="community"]')
    const barBounds = (await conference.boundingBox())!
    expect((await community.boundingBox())!.y).toBeGreaterThanOrEqual(
      barBounds.y + barBounds.height,
    )
    await conference.focus()
    await page.keyboard.press('Space')
    const details = page.getByRole('dialog', { name: 'Design conference', exact: true })
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: 'Edit event', exact: true }).first().click()
    const editor = page.getByRole('dialog', { name: 'Edit event', exact: true })
    await expect(editor.getByLabel('Start date', { exact: true })).toHaveValue('2026-10-26')
    await expect(editor.getByLabel('End date', { exact: true })).toHaveValue('2026-10-28')
    await expect(editor.getByLabel('Start time', { exact: true })).toHaveValue('09:00')
    await expect(editor.getByLabel('End time', { exact: true })).toHaveValue('11:00')
    await page.keyboard.press('Escape')

    const personal = page.getByRole('checkbox', { name: 'Show Personal calendar', exact: true })
    await personal.uncheck()
    await expect(conference).toHaveCount(0)
    await expect(community).toBeVisible()
    await personal.check()
    await expect(conference).toBeVisible()
    await expect(community).toHaveCSS('top', '28px')
    await expectContinuousBar(
      conference,
      calendar.getByRole('button', { name: 'View Monday, October 26, 2026', exact: true }),
      calendar.getByRole('button', { name: 'View Wednesday, October 28, 2026', exact: true }),
    )
    const path = testInfo.outputPath(`${view}-spans.png`)
    await page.screenshot({ path })
    await testInfo.attach(`${name} spans`, { path, contentType: 'image/png' })

    await conference.focus()
    await page.keyboard.press('d')
    const day = page.getByRole('region', { name: 'Day calendar', exact: true })
    await expect(day.locator('.timed-event[data-event-id="conference"]')).toHaveCount(1)
    await expect(day.locator('.all-day-event[data-event-id="conference"]')).toHaveCount(0)
    await page.keyboard.press('a')
    const schedule = page.getByRole('region', { name: 'Schedule calendar', exact: true })
    await expect(schedule.getByRole('button', { name: /Design conference/ })).toHaveCount(3)
  })

  test(`${name} clips bars at both visible edges and updates after navigation`, async ({
    page,
  }) => {
    await seed(page, view, [event({ start: '2026-10-23', end: '2026-11-06' })])
    const calendar = page.getByRole('region', { name: `${name} calendar`, exact: true })
    const bar = calendar.locator('.all-day-event')
    await expect(bar).toHaveCount(1)
    await expect(bar).toHaveClass(/continues-before/)
    await expect(bar).toHaveClass(/continues-after/)
    await expectContinuousBar(
      bar,
      calendar.locator('.day-heading').first(),
      calendar.locator('.day-heading').last(),
    )
    await page.getByRole('button', { name: 'Next period', exact: true }).click()
    await expect(bar).toHaveCount(1)
    await expect(bar).toHaveClass(/continues-before/)
    await expect(bar).not.toHaveClass(/continues-after/)
  })
}

test('timed bars follow the display time zone and keep midnight ends exclusive', async ({
  page,
}) => {
  await seed(page, 'week', [
    event({
      allDay: false,
      start: '2026-10-26T23:00:00Z',
      end: '2026-10-28T05:00:00Z',
    }),
  ])
  const calendar = page.getByRole('region', { name: 'Week calendar', exact: true })
  const bar = calendar.locator('.all-day-event')
  await expect(bar).toBeVisible()
  await expectContinuousBar(
    bar,
    calendar.locator('.day-heading').nth(1),
    calendar.locator('.day-heading').nth(2),
  )
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByLabel('Display time zone').selectOption('Asia/Tokyo')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expectContinuousBar(
    bar,
    calendar.locator('.day-heading').nth(2),
    calendar.locator('.day-heading').nth(3),
  )
})

test('month resize keeps whole bars and exact overflow counts reachable', async ({ page }) => {
  const events = [
    event({ id: 'top', start: '2026-10-25', end: '2026-11-01' }),
    event({ id: 'lower', start: '2026-10-26', end: '2026-10-29' }),
    ...Array.from({ length: 5 }, (_, index) =>
      event({ id: `extra-${index}`, start: '2026-10-26', end: '2026-10-27' }),
    ),
    event({ id: 'quiet', start: '2026-11-05', end: '2026-11-06' }),
  ]
  await page.setViewportSize({ width: 1440, height: 1600 })
  await seed(page, 'month', events)
  const month = page.getByRole('region', { name: 'Month calendar', exact: true })
  await expect(month.locator('.more-events')).toHaveCount(0)
  await expect(month.locator('.month-event')).toHaveCount(8)
  await page.setViewportSize({ width: 860, height: 620 })
  await expect(month.locator('.more-events')).toHaveCount(7)
  await expect(month.locator('[data-event-id="top"]')).toHaveCount(0)
  await expect(month.locator('[data-event-id="lower"]')).toHaveCount(0)
  await expect(month.locator('[data-event-id="quiet"]')).toBeVisible()
  for (const [day, count] of [
    ['25', 1],
    ['26', 7],
    ['27', 2],
    ['28', 2],
    ['29', 1],
    ['30', 1],
    ['31', 1],
  ] as const) {
    const more = month.locator(`[data-date="2026-10-${day}"] .more-events`)
    await expect(more).toHaveText(`${count} more`)
    await expect(more).toBeInViewport()
    expect(
      await more.evaluate((button) => {
        const bounds = button.getBoundingClientRect()
        const cell = button.closest('.month-day')!.getBoundingClientRect()
        return (
          bounds.top >= cell.top &&
          bounds.bottom <= cell.bottom &&
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) ===
            button
        )
      }),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 1600 })
  await expect(month.locator('.more-events')).toHaveCount(0)
  await expect(month.locator('[data-event-id="top"]')).toHaveCount(1)
  await page.setViewportSize({ width: 860, height: 620 })
  await month.locator('[data-date="2026-10-26"] .more-events').click()
  await expect(page.getByRole('region', { name: 'Day calendar', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('October 26, 2026')
})
