import { test, expect } from '@playwright/test'

test.describe('Home page visual baseline', () => {
  test('matches the committed screenshot', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('home.png', { fullPage: true })
  })
})
