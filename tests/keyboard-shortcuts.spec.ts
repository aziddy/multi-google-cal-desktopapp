import { expect, test } from '@playwright/test'
import { createDemoSnapshot } from '../src/data/fixtures'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-28T17:00:00Z'))
  const snapshot = createDemoSnapshot('2026-10-28', 'America/Chicago')
  snapshot.events = [
    {
      id: 'shortcut-event',
      accountId: 'personal',
      calendarId: 'personal',
      title: 'A keyboard appointment',
      start: '2026-10-28',
      end: '2026-10-29',
      allDay: true,
      timeZone: 'America/Chicago',
    },
  ]
  await page.addInitScript((snapshot) => {
    localStorage.setItem('calendar-demo-v1', JSON.stringify(snapshot))
  }, snapshot)
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Week calendar', exact: true })).toBeVisible()
})

test('letter and number view aliases and period navigation use the current view', async ({
  page,
}) => {
  for (const [letter, number, view] of [
    ['d', '1', 'Day'],
    ['w', '2', 'Week'],
    ['m', '3', 'Month'],
    ['x', '4', '7 days'],
    ['a', '5', 'Schedule'],
  ]) {
    for (const key of [letter, number]) {
      await page.keyboard.press(key)
      await expect(
        page.getByRole('region', { name: `${view} calendar`, exact: true }),
      ).toBeVisible()
    }
  }
  await page.keyboard.press('1')
  const heading = page.getByRole('heading', { level: 1 })
  await page.keyboard.press('p')
  await expect(heading).toHaveText('October 27, 2026')
  await page.keyboard.press('k')
  await expect(heading).toHaveText('October 26, 2026')
  await page.keyboard.press('n')
  await expect(heading).toHaveText('October 27, 2026')
  await page.keyboard.press('j')
  await expect(heading).toHaveText('October 28, 2026')
  await page.keyboard.press('4')
  await page.keyboard.press('n')
  await expect(page.locator('.day-heading').first()).toHaveAccessibleName(
    'View Wednesday, November 4, 2026',
  )
  await page.keyboard.press('t')
  await expect(page.locator('.day-heading').first()).toHaveAccessibleName(
    'View Wednesday, October 28, 2026',
  )
  await page.keyboard.press('3')
  await page.keyboard.press('j')
  await expect(heading).toHaveText('November 2026')
  await page.keyboard.press('k')
  await expect(heading).toHaveText('October 2026')
})

test('Go to date preserves the view, supports cancel, and is available from the heading', async ({
  page,
}) => {
  await page.keyboard.press('4')
  await page.keyboard.press('g')
  const picker = page.getByRole('dialog', { name: 'Go to date', exact: true })
  await expect(picker.getByLabel('Date', { exact: true })).toBeFocused()
  await picker.getByLabel('Date', { exact: true }).fill('2027-01-05')
  await picker.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(page.locator('.day-heading').first()).toHaveAccessibleName(
    'View Tuesday, January 5, 2027',
  )
  await expect(page.getByRole('button', { name: 'Choose calendar view' })).toHaveText('7 days')
  await page.getByRole('button', { name: /^Go to date,/ }).click()
  await picker.getByLabel('Date', { exact: true }).fill('2028-02-29')
  await page.keyboard.press('Escape')
  await expect(picker).not.toBeVisible()
  await expect(page.locator('.day-heading').first()).toHaveAccessibleName(
    'View Tuesday, January 5, 2027',
  )
})

test('create and save shortcuts respect form validation and text editing', async ({ page }) => {
  await page.keyboard.press('q')
  const editor = page.getByRole('dialog', { name: 'Create event', exact: true })
  await expect(editor.getByRole('checkbox', { name: 'All day', exact: true })).toBeChecked()
  await page.keyboard.press('Meta+s')
  await expect(editor.getByRole('alert')).toHaveText('Give your event a title.')
  const title = editor.getByRole('textbox', { name: 'Event title' })
  await title.fill('Shortcut all-day event')
  await title.press('Backspace')
  await expect(editor.getByText('Delete this event?', { exact: true })).toHaveCount(0)
  await title.fill('Shortcut all-day event')
  await page.keyboard.press('Control+Enter')
  await expect(editor).not.toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Shortcut all-day event', exact: true }),
  ).toBeVisible()
  for (const key of ['c', 'Shift+c']) {
    await page.keyboard.press(key)
    await expect(editor.getByRole('checkbox', { name: 'All day', exact: true })).not.toBeChecked()
    await editor.getByRole('textbox', { name: 'Event title' }).press('x')
    await page.keyboard.press('Escape')
    await expect(editor).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Choose calendar view' })).toHaveText('Week')
  }
})

test('edit and delete shortcuts stay in the event dialog and always ask before deleting', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'A keyboard appointment', exact: true }).click()
  await page.keyboard.press('e')
  const editor = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await expect(editor).toBeVisible()
  const title = editor.getByRole('textbox', { name: 'Event title' })
  await title.fill('A renamed appointment')
  await title.press('Delete')
  await expect(editor.getByText('Delete this event?', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Meta+Enter')
  await expect(editor).not.toBeVisible()
  await page.getByRole('button', { name: 'A renamed appointment', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'A renamed appointment', exact: true })
  await page.keyboard.press('Backspace')
  await expect(details.getByText('Delete this event?', { exact: true })).toBeVisible()
  await page.keyboard.press('e')
  await expect(editor).toHaveCount(0)
  await details.getByRole('button', { name: 'Keep event', exact: true }).click()
  await page.keyboard.press('Delete')
  await expect(details.getByText('Delete this event?', { exact: true })).toBeVisible()
  await details.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(details).not.toBeVisible()
  await expect(
    page.getByRole('button', { name: 'A renamed appointment', exact: true }),
  ).toHaveCount(0)
})

test('settings, help, search, menus, and typing keep their keyboard contexts', async ({ page }) => {
  await page.keyboard.press('s')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await page.keyboard.press('c')
  await page.keyboard.press('g')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
  for (const key of ['?', 'Meta+/', 'Control+/']) {
    await page.keyboard.press(key)
    const help = page.getByRole('dialog', { name: 'Your calendars, one place.', exact: true })
    await expect(help).toBeVisible()
    await expect(help.getByText('Backspace / Delete', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(help).not.toBeVisible()
  }
  await page.keyboard.press('/')
  const search = page.getByRole('textbox', { name: 'Search events', exact: true })
  await expect(search).toBeFocused()
  await search.pressSequentially('csg?12345')
  await expect(search).toHaveValue('csg?12345')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Choose calendar view' })).toHaveText('Week')
  await page.getByRole('button', { name: 'Choose calendar view' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Calendar views' })).toHaveCount(0)
  await expect(search).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(search).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Search events', exact: true })).toBeFocused()
})

test('held keys and composition do not open or repeat actions', async ({ page }) => {
  await page.evaluate(() => {
    for (const options of [{ repeat: true }, { isComposing: true }]) {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'c', bubbles: true, ...options }),
      )
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', bubbles: true, ...options }),
      )
    }
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.keyboard.press('1')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('October 28, 2026')
})

test('date and shortcut dialogs fit a compact desktop window', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 860, height: 620 })
  await page.keyboard.press('g')
  const picker = page.getByRole('dialog', { name: 'Go to date', exact: true })
  await expect(picker.getByRole('button', { name: 'Go', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('go-to-date.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Your calendars, one place.', exact: true })
  expect(await help.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('shortcut-help.png'), animations: 'disabled' })
  await help.getByText('Keyboard shortcuts', { exact: true }).scrollIntoViewIfNeeded()
  await expect(help.getByText('Keyboard shortcuts', { exact: true })).toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(help).not.toBeVisible()
})
