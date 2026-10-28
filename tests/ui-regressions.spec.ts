import { expect, test, type Page } from '@playwright/test'
import { createDemoSnapshot } from '../src/data/fixtures'
import { addDays, monthDays } from '../src/domain/calendar'

const today = '2026-10-26'
const timeZone = 'America/Chicago'
const preferenceKey = 'multi-calendar-preferences-v1'

async function seed(page: Page, crowdedMonth = false) {
  const snapshot = createDemoSnapshot(today, timeZone)
  snapshot.events = crowdedMonth
    ? monthDays(today).flatMap((day) =>
        Array.from({ length: 5 }, (_, index) => ({
          id: `${day}-${index}`,
          accountId: 'personal',
          calendarId: 'personal',
          title: `Moment ${index + 1}`,
          start: day,
          end: addDays(day, 1),
          allDay: true,
          timeZone,
        })),
      )
    : [
        {
          id: 'preview-delete-regression',
          accountId: 'personal',
          calendarId: 'personal',
          title: 'A moment to keep or delete',
          start: today,
          end: addDays(today, 1),
          allDay: true,
          timeZone,
        },
      ]
  await page.clock.install({ time: new Date('2026-10-26T17:00:00Z') })
  await page.addInitScript(
    ({ snapshot, preferenceKey, crowdedMonth, timeZone }) => {
      localStorage.setItem('calendar-demo-v1', JSON.stringify(snapshot))
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({
          state: { view: crowdedMonth ? 'month' : 'week', theme: 'light', timeZone },
          version: 0,
        }),
      )
    },
    { snapshot, preferenceKey, crowdedMonth, timeZone },
  )
  await page.goto('/')
}

test('crowded month overflow remains reachable at the minimum desktop size', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 620 })
  await seed(page, true)
  const month = page.getByRole('region', { name: 'Month calendar', exact: true })
  await expect(month).toBeVisible()
  const more = month.getByRole('button', { name: /\d+ more/ })
  await expect(more).toHaveCount(42)
  await expect
    .poll(async () =>
      more.evaluateAll(
        (buttons) =>
          buttons.filter((button) => {
            const cell = button.closest('.month-day')!.getBoundingClientRect()
            const bounds = button.getBoundingClientRect()
            const hit = document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            )
            return (
              bounds.top < cell.top ||
              bounds.bottom > cell.bottom ||
              bounds.left < cell.left ||
              bounds.right > cell.right ||
              !hit ||
              !button.contains(hit)
            )
          }).length,
      ),
    )
    .toBe(0)
  await more.first().click()
  await expect(page.getByRole('region', { name: 'Day calendar', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('September 27, 2026')
})

test('preview trash confirms directly and keeping the event preserves it', async ({ page }) => {
  await seed(page)
  const title = 'A moment to keep or delete'
  await page.getByRole('button', { name: title, exact: true }).click()
  const preview = page.getByRole('dialog', { name: title, exact: true })
  await preview.getByRole('button', { name: 'Delete event', exact: true }).click()
  await expect(preview.getByText('Delete this event?', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true })).toHaveCount(0)
  await preview.getByRole('button', { name: 'Keep event', exact: true }).click()
  await expect(preview.getByText('Delete this event?', { exact: true })).toHaveCount(0)
  await preview.getByRole('button', { name: 'Close event details', exact: true }).click()
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
  await page.getByRole('button', { name: title, exact: true }).click()
  await preview.getByRole('button', { name: 'Delete event', exact: true }).click()
  await preview.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(preview).not.toBeVisible()
  await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0)
})

test('preference quota failures show an alert and recover through retry', async ({ page }) => {
  await page.addInitScript((preferenceKey) => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === preferenceKey)
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      return original.call(this, key, value)
    }
    Object.defineProperty(window, 'restorePreferenceStorage', {
      value: () => {
        Storage.prototype.setItem = original
      },
      configurable: true,
    })
  }, preferenceKey)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Week calendar', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Dark', exact: true }).click()
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Preferences haven’t been saved')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.evaluate(() => {
    const restore = Reflect.get(window, 'restorePreferenceStorage') as () => void
    restore()
  })
  await alert.getByRole('button', { name: 'Retry saving', exact: true }).click()
  await expect(alert).toHaveCount(0)
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).state.theme as string,
    preferenceKey,
  )
  expect(saved).toBe('dark')
  expect(errors).toEqual([])
})

test('demo settings stack in narrow windows and keep reset controls reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 620 })
  await seed(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  const general = await dialog.locator('.settings-general').boundingBox()
  const demo = await dialog.locator('.settings-demo-pane').boundingBox()
  expect(demo!.y).toBeGreaterThan(general!.y + general!.height)
  expect(demo!.x).toBe(general!.x)
  expect(
    await dialog.locator('.settings-body').evaluate((body) => body.scrollWidth > body.clientWidth),
  ).toBe(false)
  await dialog.getByRole('button', { name: 'Reset demo data' }).click()
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  await cancel.scrollIntoViewIfNeeded()
  await expect(cancel).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeInViewport()
  await cancel.click()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})
