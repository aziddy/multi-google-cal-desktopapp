import { expect, test, type Page } from '@playwright/test'
import { Temporal } from '@js-temporal/polyfill'

async function chooseView(page: Page, view: 'Day' | 'Week' | 'Month' | 'Schedule' | '7 days') {
  await page.getByRole('button', { name: 'Choose calendar view' }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(`^${view}`) }).click()
  await expect(page.getByRole('region', { name: `${view} calendar`, exact: true })).toBeVisible()
}

async function searchFor(page: Page, title: string) {
  const input = page.getByRole('textbox', { name: 'Search events', exact: true })
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Search events', exact: true }).click()
  await input.fill(title)
  return page.getByRole('region', { name: 'Search results', exact: true })
}

async function openNewEvent(page: Page, title: string) {
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create event', exact: true })
  await dialog.getByRole('textbox', { name: 'Event title' }).fill(title)
  return dialog
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Week calendar', exact: true })).toBeVisible()
})

test('all calendar views and date navigation work', async ({ page }) => {
  const heading = page.getByRole('heading', { level: 1 })
  for (const view of ['Day', 'Week', 'Month', 'Schedule', '7 days'] as const) {
    await chooseView(page, view)
    const calendar = page.getByRole('region', { name: `${view} calendar`, exact: true })
    const original = await calendar.innerText()
    await page.getByRole('button', { name: 'Next period', exact: true }).click()
    await expect(calendar).not.toHaveText(original, { useInnerText: true })
    await page.getByRole('button', { name: 'Previous period', exact: true }).click()
    await expect(calendar).toHaveText(original, { useInnerText: true })
  }
  await chooseView(page, 'Day')
  const original = await heading.textContent()
  await page.getByRole('button', { name: 'Next period', exact: true }).click()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(heading).toHaveText(original!)
})

test('7 days rolls from the selected date, navigates by seven, and survives reload', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-10-27T17:00:00Z'))
  await page.reload()
  await chooseView(page, '7 days')
  const calendar = page.getByRole('region', { name: '7 days calendar', exact: true })
  const headings = calendar.locator('.day-heading')
  const heading = page.getByRole('heading', { level: 1 })
  await expect(headings).toHaveCount(7)
  await expect(headings.first()).toHaveAccessibleName('View Tuesday, October 27, 2026')
  await expect(headings.last()).toHaveAccessibleName('View Monday, November 2, 2026')
  await expect(heading).toHaveText('Oct – Nov 2026')

  await calendar
    .getByRole('button', { name: 'Create all-day event on 2026-11-02', exact: true })
    .click()
  const editor = page.getByRole('dialog', { name: 'Create event', exact: true })
  await expect(editor.getByLabel('Start date', { exact: true })).toHaveValue('2026-11-02')
  await editor.getByRole('textbox', { name: 'Event title' }).fill('A moment next month')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(
    calendar.getByRole('button', { name: 'A moment next month', exact: true }),
  ).toBeVisible()

  await page.getByRole('gridcell', { name: 'Thursday, October 29, 2026', exact: true }).click()
  await expect(headings.first()).toHaveAccessibleName('View Thursday, October 29, 2026')
  await expect(headings.last()).toHaveAccessibleName('View Wednesday, November 4, 2026')
  await page.getByRole('button', { name: 'Next period', exact: true }).click()
  await expect(headings.first()).toHaveAccessibleName('View Thursday, November 5, 2026')
  await expect(headings.last()).toHaveAccessibleName('View Wednesday, November 11, 2026')
  await page.getByRole('button', { name: 'Previous period', exact: true }).click()
  await expect(headings.first()).toHaveAccessibleName('View Thursday, October 29, 2026')
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(headings.first()).toHaveAccessibleName('View Tuesday, October 27, 2026')

  await chooseView(page, 'Week')
  await expect(page.locator('.day-heading').first()).toHaveAccessibleName(
    'View Sunday, October 25, 2026',
  )
  await page.keyboard.press('x')
  await expect(headings.first()).toHaveAccessibleName('View Tuesday, October 27, 2026')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Choose calendar view' })).toHaveText('7 days')
  await expect(headings.first()).toHaveAccessibleName('View Tuesday, October 27, 2026')
  await expect(
    calendar.getByRole('button', { name: 'A moment next month', exact: true }),
  ).toBeVisible()
})

test('7 days shows both years when its dates span New Year', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-29T17:00:00Z'))
  await page.reload()
  await page.keyboard.press('x')
  const calendar = page.getByRole('region', { name: '7 days calendar', exact: true })
  await expect(calendar.locator('.day-heading').first()).toHaveAccessibleName(
    'View Tuesday, December 29, 2026',
  )
  await expect(calendar.locator('.day-heading').last()).toHaveAccessibleName(
    'View Monday, January 4, 2027',
  )
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dec 2026 – Jan 2027')
})

test('calendar visibility filters events and survives reload', async ({ page }) => {
  const workToggle = page.getByRole('checkbox', { name: 'Show Work calendar', exact: true })
  await expect(workToggle).toBeChecked()
  await expect(page.getByRole('button', { name: /^Team standup,/ }).first()).toBeVisible()
  await workToggle.uncheck()
  await expect(page.getByRole('button', { name: /^Team standup,/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Design review,/ })).toBeVisible()
  await page.reload()
  await expect(workToggle).not.toBeChecked()
  const results = await searchFor(page, 'Team standup')
  await expect(results.getByRole('heading', { name: 'No matching events' })).toBeVisible()
  await workToggle.check()
  await expect(results.getByRole('button', { name: /Team standup/ }).first()).toBeVisible()
})

test('event creation, search, editing, persistence, and confirmed deletion', async ({ page }) => {
  const title = 'A little time for the prototype'
  let editor = await openNewEvent(page, title)
  await editor.getByRole('textbox', { name: 'Location', exact: true }).fill('Little Finch Café')
  await editor
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Bring a notebook and some ideas.')
  await editor.getByLabel('Start time', { exact: true }).fill('11:00')
  await editor.getByLabel('End time', { exact: true }).fill('12:00')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(page.getByRole('status')).toContainText('Event created')
  let results = await searchFor(page, title)
  await results.getByRole('button', { name: new RegExp(title) }).click()
  let details = page.getByRole('dialog', { name: title, exact: true })
  await expect(details.getByText('Little Finch Café', { exact: true })).toBeVisible()
  await expect(details.getByText('Bring a notebook and some ideas.', { exact: true })).toBeVisible()
  await details.getByRole('button', { name: 'Edit event', exact: true }).first().click()
  editor = page.getByRole('dialog', { name: 'Edit event', exact: true })
  const updatedTitle = 'A little time, well spent'
  await editor.getByRole('textbox', { name: 'Event title' }).fill(updatedTitle)
  await editor
    .getByRole('combobox', { name: 'Calendar', exact: true })
    .selectOption({ label: 'Family' })
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await page.reload()
  results = await searchFor(page, updatedTitle)
  await results.getByRole('button', { name: new RegExp(updatedTitle) }).click()
  details = page.getByRole('dialog', { name: updatedTitle, exact: true })
  await expect(details).toContainText('Family')
  await expect(details.getByText('Little Finch Café', { exact: true })).toBeVisible()
  await details.getByRole('button', { name: 'Edit event', exact: true }).first().click()
  editor = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await editor.getByRole('button', { name: 'Delete event', exact: true }).click()
  await expect(editor.getByText('Delete this event?', { exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'Keep event', exact: true }).click()
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: 'Delete event', exact: true }).click()
  await editor.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(results.getByRole('heading', { name: 'No matching events' })).toBeVisible()
  await page.reload()
  results = await searchFor(page, updatedTitle)
  await expect(results.getByRole('heading', { name: 'No matching events' })).toBeVisible()
})

test('editing a title preserves a repeated-hour instant and sub-minute precision', async ({
  page,
}) => {
  const original = { start: '2026-11-01T07:30:12.345Z', end: '2026-11-01T08:30:42.123456789Z' }
  await page.evaluate((range) => {
    const snapshot = JSON.parse(localStorage.getItem('calendar-demo-v1')!) as { events: unknown[] }
    snapshot.events.push({
      id: 'fold-regression',
      accountId: 'personal',
      calendarId: 'personal',
      title: 'A repeated hour',
      ...range,
      allDay: false,
      timeZone: 'America/Chicago',
    })
    localStorage.setItem('calendar-demo-v1', JSON.stringify(snapshot))
  }, original)
  await page.reload()
  const results = await searchFor(page, 'A repeated hour')
  await results.getByRole('button', { name: /A repeated hour/ }).click()
  await page
    .getByRole('dialog', { name: 'A repeated hour', exact: true })
    .getByRole('button', { name: 'Edit event', exact: true })
    .first()
    .click()
  const editor = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await expect(editor.getByLabel('Start time', { exact: true })).toHaveValue('01:30')
  await editor.getByRole('textbox', { name: 'Event title' }).fill('The same repeated hour')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const saved = await page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem('calendar-demo-v1')!) as {
      events: { id: string; title: string; start: string; end: string }[]
    }
    return snapshot.events.find((event) => event.id === 'fold-regression')
  })
  expect(saved).toMatchObject({ title: 'The same repeated hour', ...original })
})

test('invalid event times stay in the editor and multi-day all-day dates stay stable', async ({
  page,
}) => {
  const title = 'A few days away'
  let editor = await openNewEvent(page, title)
  await editor.getByLabel('Start time', { exact: true }).fill('12:00')
  await editor.getByLabel('End time', { exact: true }).fill('11:00')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('alert')).toHaveText('The end time must be after the start time.')
  await editor.getByRole('checkbox', { name: 'All day', exact: true }).check()
  const start = await editor.getByLabel('Start date', { exact: true }).inputValue()
  const inclusiveEnd = Temporal.PlainDate.from(start).add({ days: 2 }).toString()
  await editor.getByLabel('End date', { exact: true }).fill(inclusiveEnd)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByLabel('Display time zone').selectOption('Asia/Tokyo')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  const results = await searchFor(page, title)
  await results.getByRole('button', { name: new RegExp(title) }).click()
  const details = page.getByRole('dialog', { name: title, exact: true })
  await expect(details).toContainText('All day')
  await details.getByRole('button', { name: 'Edit event', exact: true }).first().click()
  editor = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await expect(editor.getByLabel('Start date', { exact: true })).toHaveValue(start)
  await expect(editor.getByLabel('End date', { exact: true })).toHaveValue(inclusiveEnd)
})

test('timed events move and resize in fifteen-minute increments', async ({ page }) => {
  await chooseView(page, 'Day')
  const editor = await openNewEvent(page, 'Move this moment')
  await editor.getByLabel('Start time', { exact: true }).fill('11:00')
  await editor.getByLabel('End time', { exact: true }).fill('12:00')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const event = page.getByRole('button', { name: /^Move this moment,/ })
  await event.scrollIntoViewIfNeeded()
  const initial = await event.boundingBox()
  expect(initial).not.toBeNull()
  await page.mouse.move(initial!.x + 35, initial!.y + 14)
  await page.mouse.down()
  await page.mouse.move(initial!.x + 35, initial!.y + 46, { steps: 8 })
  await page.mouse.up()
  await expect(event).toHaveAccessibleName('Move this moment, 11:30am to 12:30pm')
  const handle = event.getByRole('slider', { name: 'Resize Move this moment' })
  const edge = await handle.boundingBox()
  expect(edge).not.toBeNull()
  await page.mouse.move(edge!.x + edge!.width / 2, edge!.y + edge!.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge!.x + edge!.width / 2, edge!.y + edge!.height / 2 + 16, { steps: 8 })
  await page.mouse.up()
  await expect(event).toHaveAccessibleName('Move this moment, 11:30am to 12:45pm')
})

test('overnight events resize at their end and move from a continuation', async ({ page }) => {
  await chooseView(page, 'Day')
  const editor = await openNewEvent(page, 'An overnight journey')
  const startDate = await editor.getByLabel('Start date', { exact: true }).inputValue()
  const nextDate = Temporal.PlainDate.from(startDate).add({ days: 1 }).toString()
  await editor.getByLabel('Start time', { exact: true }).fill('23:00')
  await editor.getByLabel('End date', { exact: true }).fill(nextDate)
  await editor.getByLabel('End time', { exact: true }).fill('02:00')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  let event = page.getByRole('button', { name: /^An overnight journey,/ })
  await expect(event).toHaveAccessibleName('An overnight journey, 11pm to 2am')
  await expect(event.getByRole('slider', { name: 'Resize An overnight journey' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Next period', exact: true }).click()
  await page.locator('.time-scroll').evaluate((element) => {
    element.scrollTop = 0
  })
  event = page.getByRole('button', { name: /^An overnight journey,/ })
  await expect(event).toBeVisible()
  const handle = event.getByRole('slider', { name: 'Resize An overnight journey' })
  const edge = await handle.boundingBox()
  expect(edge).not.toBeNull()
  await page.mouse.move(edge!.x + edge!.width / 2, edge!.y + edge!.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge!.x + edge!.width / 2, edge!.y + edge!.height / 2 + 32, { steps: 8 })
  await page.mouse.up()
  await expect(event).toHaveAccessibleName('An overnight journey, 11pm to 2:30am')
  const segment = await event.boundingBox()
  expect(segment).not.toBeNull()
  await page.mouse.move(segment!.x + 35, segment!.y + 30)
  await page.mouse.down()
  await page.mouse.move(segment!.x + 35, segment!.y + 94, { steps: 8 })
  await page.mouse.up()
  await expect(event).toHaveAccessibleName('An overnight journey, 12am to 3:30am')
})

test('appearance and time zone persist and resetting requires confirmation', async ({ page }) => {
  const editor = await openNewEvent(page, 'An event to reset')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  let settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await settings.getByLabel('Display time zone').selectOption('Europe/London')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings.getByLabel('Display time zone')).toHaveValue('Europe/London')
  await expect(settings.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await settings.getByRole('button', { name: 'Reset demo data', exact: true }).click()
  await expect(settings.getByText('Replace your demo events?', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
  await settings.getByRole('button', { name: 'Close settings' }).click()
  let results = await searchFor(page, 'An event to reset')
  await expect(results.getByRole('button', { name: /An event to reset/ })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Reset demo data', exact: true }).click()
  await settings.getByRole('button', { name: 'Reset demo', exact: true }).click()
  await expect(settings.getByText('Replace your demo events?', { exact: true })).not.toBeVisible()
  await settings.getByRole('button', { name: 'Close settings' }).click()
  results = await searchFor(page, 'An event to reset')
  await expect(results.getByRole('heading', { name: 'No matching events' })).toBeVisible()
})

test('keyboard shortcuts and accessible dialogs work', async ({ page }) => {
  await page.keyboard.press('d')
  await expect(page.getByRole('region', { name: 'Day calendar', exact: true })).toBeVisible()
  await page.keyboard.press('c')
  const editor = page.getByRole('dialog', { name: 'Create event', exact: true })
  await expect(editor).toBeVisible()
  await editor.getByRole('textbox', { name: 'Event title' }).press('x')
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose calendar view' })).toHaveText('Day')
  await page.keyboard.press('/')
  await expect(page.getByRole('textbox', { name: 'Search events', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Help and keyboard shortcuts' }).click()
  const help = page.getByRole('dialog', { name: 'Your calendars, one place.', exact: true })
  await expect(help).toBeVisible()
  await expect(help.getByText(/This preview uses fictional accounts/)).toBeVisible()
  await expect(help.getByText('Go to date', { exact: true })).toBeVisible()
  await expect(help.getByText('4 / X', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help).not.toBeVisible()
})

test('capture all views in both themes and at a compact desktop width', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000)
  await page.evaluate(() => document.fonts.ready)
  for (const theme of ['Light', 'Dark'] as const) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: theme, exact: true }).click()
    await settings.getByRole('button', { name: 'Close settings' }).click()
    for (const view of ['Day', 'Week', 'Month', 'Schedule', '7 days'] as const) {
      await chooseView(page, view)
      const path = testInfo.outputPath(`${theme.toLowerCase()}-${view.toLowerCase()}.png`)
      await page.screenshot({ path, animations: 'disabled' })
      await testInfo.attach(`${theme} ${view}`, { path, contentType: 'image/png' })
    }
  }
  await page.setViewportSize({ width: 1000, height: 800 })
  await chooseView(page, 'Week')
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expect(hasHorizontalOverflow).toBe(false)
  const path = testInfo.outputPath('compact-week.png')
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach('Compact week', { path, contentType: 'image/png' })
  const editor = await openNewEvent(page, 'Time for what matters')
  const editorPath = testInfo.outputPath('event-editor.png')
  await page.screenshot({ path: editorPath, animations: 'disabled' })
  await testInfo.attach('Event editor', { path: editorPath, contentType: 'image/png' })
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsPath = testInfo.outputPath('settings.png')
  await page.screenshot({ path: settingsPath, animations: 'disabled' })
  await testInfo.attach('Settings', { path: settingsPath, contentType: 'image/png' })
})
