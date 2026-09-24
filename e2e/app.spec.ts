import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Full user journey against the production build in mock Gemini mode (see playwright.config.ts):
 * sign in, write a script, upload a character, preview the split, generate, watch progress, play and
 * download the 20s video, regenerate part 2 only, and find both videos in the history.
 */

const CHARACTER = fileURLToPath(new URL('./fixtures/character.png', import.meta.url));
const PASSWORD = 'e2e-password';
const SCRIPT =
  'Okay, I tested this vitamin C serum for two weeks. My skin looks brighter and the texture is smoother. ' +
  'It absorbs fast and layers well under sunscreen. Would I buy it again? Honestly, yes.';

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Create a 20-second video' })).toBeVisible();
}

async function waitForReady(page: Page): Promise<void> {
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 150_000 });
}

test('rejects a wrong password and keeps the API closed', async ({ page, request }) => {
  const unauthenticated = await request.get('/api/generations');
  expect(unauthenticated.status()).toBe(401);

  await page.goto('/');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create a 20-second video' })).toHaveCount(0);
});

test('generates, previews, downloads and regenerates a 20s video', async ({ page }) => {
  await signIn(page);

  await page.getByLabel('Script (20 seconds)').fill(SCRIPT);
  await page.locator('input[type="file"]').setInputFiles(CHARACTER);

  // Bandys Cars theme: the dealership setting flows into the split and both prompts.
  await page.locator('label', { hasText: 'Bandys Cars' }).click();
  await expect(page.getByRole('radio', { name: /Bandys Cars/ })).toBeChecked();

  // Optional split preview: two 10s parts with a shared continuity bible.
  await page.getByRole('button', { name: 'Preview split' }).click();
  await expect(page.getByText('Continuity bible', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Generate 20s video' }).click();
  await page.waitForURL(/\/generations\/[0-9a-f-]{36}$/);
  const firstUrl = page.url();
  const id = firstUrl.split('/').pop()!;

  await waitForReady(page);

  // The API reports a ~20s video assembled by the model and an actual cost.
  const dto = await (await page.request.get(`/api/generations/${id}`)).json();
  expect(dto.status).toBe('succeeded');
  expect(dto.durationSec).toBeGreaterThan(18);
  expect(dto.durationSec).toBeLessThan(22);
  expect(dto.assembly).toBe('model_full');
  expect(dto.actualCost?.totalUsd).toBeGreaterThan(0);
  expect(dto.plan.segments).toHaveLength(2);
  expect(dto.plan.segments[1].prompt).toContain('Extend this video');
  expect(dto.settings.theme).toBe('bandys_cars');
  expect(dto.plan.setting).toContain('Bandys Cars');

  // Preview player shows the final video. Open-source Chromium builds cannot decode H.264/AAC
  // (Chrome, Safari, Edge and Firefox can); there the player must say so instead of failing silently.
  const canPlayH264 = await page.evaluate(
    () => document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') !== '',
  );
  if (canPlayH264) {
    const video = page.getByTestId('phone-player-video');
    await expect(video).toHaveAttribute('src', new RegExp(`/api/generations/${id}/video`));
    const duration = await video.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<number>((resolve) => {
          if (v.readyState >= 1) resolve(v.duration);
          else v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
        }),
    );
    expect(duration).toBeGreaterThan(18);
  } else {
    test.info().annotations.push({ type: 'note', description: 'Browser lacks H.264, playback check replaced' });
    await expect(page.getByText('This browser cannot play H.264 video.', { exact: false })).toBeVisible();
  }

  // Download returns the MP4 as an attachment; Range requests work for streaming.
  const href = await page.getByRole('link', { name: 'Download MP4' }).getAttribute('href');
  expect(href).toBeTruthy();
  const download = await page.request.get(href!);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toContain('video/mp4');
  expect(download.headers()['content-disposition']).toContain('attachment');
  expect((await download.body()).byteLength).toBeGreaterThan(10_000);
  const ranged = await page.request.get(`/api/generations/${id}/video`, { headers: { Range: 'bytes=0-99' } });
  expect(ranged.status()).toBe(206);
  expect((await ranged.body()).byteLength).toBe(100);

  // Regenerate only the extension: keeps part 1, creates a new linked generation.
  await page.getByRole('button', { name: 'Regenerate part 2 only' }).click();
  await page.getByRole('button', { name: 'Regenerate part 2', exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/generations/') && !url.href.endsWith(id));
  await waitForReady(page);
  const regenId = page.url().split('/').pop()!;
  const regen = await (await page.request.get(`/api/generations/${regenId}`)).json();
  expect(regen.parentId).toBe(id);
  expect(regen.regenerationMode).toBe('part2');
  expect(regen.durationSec).toBeGreaterThan(18);

  // Both videos are in the history.
  await page.getByRole('link', { name: 'History' }).first().click();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.locator(`a[href="/generations/${id}"]`).first()).toBeVisible();
  await expect(page.locator(`a[href="/generations/${regenId}"]`).first()).toBeVisible();
});

test('blocks generation until a character image is provided', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Script (20 seconds)').fill(SCRIPT);
  await expect(page.getByRole('button', { name: 'Generate 20s video' })).toBeDisabled();
});
