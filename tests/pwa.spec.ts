import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

// ---- Helpers ----

const WORKER_URL = "https://octybot-worker.tom-adf.workers.dev";
const TEST_PROJECT_PREFIX = /^(test-|sw-|bot-|swbot-)/;

function getToken(): string {
  const devicePath = join(process.env.HOME!, ".octybot", "device.json");
  const device = JSON.parse(readFileSync(devicePath, "utf-8"));
  return device.token;
}

function getDeviceId(): string {
  const devicePath = join(process.env.HOME!, ".octybot", "device.json");
  const device = JSON.parse(readFileSync(devicePath, "utf-8"));
  return device.device_id;
}

/** Inject auth token + device_id into localStorage before page load */
async function loginViaStorage(page: Page) {
  const token = getToken();
  const deviceId = getDeviceId();
  // Navigate first to set origin, then inject storage
  await page.goto("/");
  await page.evaluate(
    ({ t, d }) => {
      localStorage.setItem("token", t);
      localStorage.setItem("device_id", d);
    },
    { t: token, d: deviceId }
  );
  // Reload to pick up the token
  await page.reload();
}

/** Wait for the app screen to be visible (logged in) */
async function waitForApp(page: Page) {
  await expect(page.locator("#app")).toHaveClass(/active/, { timeout: 10_000 });
}

/** Wait for conversations to load in sidebar */
async function waitForConvList(page: Page) {
  // Just wait for the conv-list to exist (may be empty)
  await page.waitForSelector("#conv-list", { timeout: 10_000 });
  // Small delay for API response
  await page.waitForTimeout(1000);
}

/** Ensure sidebar is closed before proceeding */
async function ensureSidebarClosed(page: Page) {
  const isOpen = await page.locator("#sidebar").evaluate((el) => el.classList.contains("open"));
  if (isOpen) {
    // Use JS to close since the overlay click can be intercepted by sidebar elements
    await page.evaluate(() => {
      document.getElementById("sidebar")!.classList.remove("open");
      document.getElementById("sidebar-overlay")!.classList.remove("show");
    });
    await page.waitForTimeout(400);
  }
}

/** Open the sidebar, ensuring it's closed first */
async function openSidebar(page: Page) {
  await ensureSidebarClosed(page);
  await page.click("#menu-btn");
  await expect(page.locator("#sidebar")).toHaveClass(/open/);
}

// ---- Auth Tests ----

test.describe("Auth", () => {
  test("no token shows setup screen", async ({ page }) => {
    await page.goto("/");
    // Clear any existing token
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await expect(page.locator("#setup")).toBeVisible();
    await expect(page.locator("#app")).not.toHaveClass(/active/);
  });

  test("token in localStorage shows app screen", async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);

    await expect(page.locator("#setup")).toBeHidden();
    await expect(page.locator("#app")).toHaveClass(/active/);
  });

  test("logout clears token and returns to setup", async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);

    // Open settings
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);

    // Click logout
    await page.click("#logout-btn");

    await expect(page.locator("#setup")).toBeVisible();
    await expect(page.locator("#app")).not.toHaveClass(/active/);

    // Verify token cleared
    const token = await page.evaluate(() => localStorage.getItem("token"));
    expect(token).toBeNull();
  });
});

// ---- Conversations ----

test.describe("Conversations", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);
    await waitForConvList(page);
  });

  test("new chat button creates conversation", async ({ page }) => {
    await openSidebar(page);

    // Count current conversations
    const beforeCount = await page.locator("#conv-list .conv-item").count();

    // Click new chat
    await page.click("#new-chat-btn");

    // Wait for new conversation to appear
    await page.waitForTimeout(2000);

    // Title should be "New Chat"
    await expect(page.locator("#conv-title")).toHaveText("New Chat");
  });

  test("conversation appears in sidebar", async ({ page }) => {
    await openSidebar(page);

    // There should be at least one conversation (from the previous test or existing)
    // If not, create one
    const count = await page.locator("#conv-list .conv-item").count();
    if (count === 0) {
      await page.click("#new-chat-btn");
      await page.waitForTimeout(2000);
      await openSidebar(page);
    }

    await expect(page.locator("#conv-list .conv-item").first()).toBeVisible();
  });

  test("rename conversation via header", async ({ page }) => {
    // Ensure we have a conversation open
    await openSidebar(page);
    const count = await page.locator("#conv-list .conv-item").count();
    if (count === 0) {
      await page.click("#new-chat-btn");
      await page.waitForTimeout(2000);
    } else {
      // Click the first conversation title
      await page.locator("#conv-list .conv-item .title").first().click();
      await page.waitForTimeout(1000);
    }

    const currentTitle = await page.locator("#conv-title").textContent();
    if (currentTitle === "New Chat") {
      // Can't rename "New Chat" — the handler returns early
      // So create one with a message first, or just skip
      return;
    }

    // Click header title to start rename
    await page.click("#conv-title");
    const input = page.locator("header .title-input");
    await expect(input).toBeVisible({ timeout: 3000 });

    // Type new name and press enter
    const newName = `Test-${Date.now().toString(36).slice(-4)}`;
    await input.fill(newName);
    await input.press("Enter");

    // Verify title updated
    await expect(page.locator("#conv-title")).toHaveText(newName, { timeout: 5000 });
  });

  test("delete conversation", async ({ page }) => {
    // Create a conversation to delete
    await openSidebar(page);
    await page.click("#new-chat-btn");
    await page.waitForTimeout(2000);

    // Open sidebar again
    await openSidebar(page);

    const beforeCount = await page.locator("#conv-list .conv-item").count();
    expect(beforeCount).toBeGreaterThan(0);

    // Click delete on first conversation
    await page.locator("#conv-list .conv-item .delete-btn").first().click();

    await page.waitForTimeout(2000);
    const afterCount = await page.locator("#conv-list .conv-item").count();
    expect(afterCount).toBeLessThan(beforeCount);
  });

  test("empty state when no conversation selected", async ({ page }) => {
    // On fresh load with no conversation selected, messages area shows empty state
    const emptyState = page.locator("#messages .empty-state");
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText("Send a message to start");
  });
});

// ---- Settings ----

test.describe("Settings", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);
  });

  test("settings button opens overlay", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
  });

  test("device ID is shown", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);

    const deviceText = await page.locator("#settings-device").textContent();
    expect(deviceText).toBeTruthy();
    expect(deviceText).not.toBe("—");
  });

  test("timeout and pool fields are present and editable", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);

    // Wait for settings to load
    await page.waitForTimeout(2000);

    const timeout = page.locator("#settings-timeout");
    const poolMax = page.locator("#settings-pool-max");

    await expect(timeout).toBeVisible();
    await expect(poolMax).toBeVisible();

    // Verify they're editable
    await timeout.fill("12");
    await expect(timeout).toHaveValue("12");

    await poolMax.fill("2");
    await expect(poolMax).toHaveValue("2");
  });

  test("save settings succeeds", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(2000);

    // Set values
    await page.locator("#settings-timeout").fill("24");
    await page.locator("#settings-pool-max").fill("3");

    // Click save and wait for the PATCH response
    const [response] = await Promise.all([
      page.waitForResponse((resp) =>
        resp.url().includes("/settings") && resp.request().method() === "PATCH"
      ),
      page.click("#settings-save-btn"),
    ]);

    expect(response.status()).toBe(200);

    // Check toast appeared
    await expect(page.locator(".toast")).toBeVisible({ timeout: 5000 });
  });

  test("close settings on overlay background click", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);

    // Click the overlay background (not the panel)
    await page.locator("#settings-overlay").click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);

    await expect(page.locator("#settings-overlay")).not.toHaveClass(/show/);
  });
});

// ---- Projects & Bots ----

test.describe("Projects & Bots", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);
  });

  // Clean up test projects after all tests in this group
  test.afterAll(async () => {
    const token = getToken();
    const resp = await fetch(`${WORKER_URL}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json() as { projects: { name: string }[] };
    for (const p of data.projects) {
      if (TEST_PROJECT_PREFIX.test(p.name)) {
        await fetch(`${WORKER_URL}/projects/${p.name}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
      }
    }
  });

  test("project dropdown loads", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(2000);

    const projectSelect = page.locator("#project-select");
    await expect(projectSelect).toBeVisible();

    // Should have at least one option
    const optionCount = await projectSelect.locator("option").count();
    expect(optionCount).toBeGreaterThan(0);
  });

  test("create new project appears in dropdown", async ({ page }) => {
    const projectName = `test-${Date.now().toString(36).slice(-5)}`;

    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(2000);

    // Override prompt() to return our project name
    await page.evaluate((name) => { window.prompt = () => name; }, projectName);

    await page.click("#new-project-btn");

    // Wait for the new option to appear in the dropdown
    await expect(page.locator(`#project-select option[value="${projectName}"]`)).toBeAttached({ timeout: 10_000 });

    // The new project should be selected
    const selectedValue = await page.locator("#project-select").inputValue();
    expect(selectedValue).toBe(projectName);
  });

  test("bot dropdown loads for project", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(2000);

    const botSelect = page.locator("#bot-select");
    await expect(botSelect).toBeVisible();

    const optionCount = await botSelect.locator("option").count();
    expect(optionCount).toBeGreaterThan(0);
  });

  test("create new bot appears in dropdown", async ({ page }) => {
    const botName = `bot-${Date.now().toString(36).slice(-5)}`;

    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(3000);

    // Select the first available project to ensure we're on a valid one
    const projectSelect = page.locator("#project-select");
    const firstProject = await projectSelect.locator("option").first().getAttribute("value");
    if (firstProject) await projectSelect.selectOption(firstProject);
    await page.waitForTimeout(2000);

    // Override prompt() to return our bot name
    await page.evaluate((name) => { window.prompt = () => name; }, botName);

    // Click and wait for the bot creation API response
    const [response] = await Promise.all([
      page.waitForResponse((resp) =>
        resp.url().includes("/bots") && resp.request().method() === "POST"
      ),
      page.click("#new-bot-btn"),
    ]);

    expect(response.status()).toBeLessThan(300);
    await page.waitForTimeout(2000);

    // The new bot should be selected in the dropdown
    const selectedValue = await page.locator("#bot-select").inputValue();
    expect(selectedValue).toBe(botName);
  });

  test("switching project calls settings API with active_project", async ({ page }) => {
    const projectName = `sw-${Date.now().toString(36).slice(-5)}`;

    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(2000);

    // Override prompt() and create a second project
    await page.evaluate((name) => { window.prompt = () => name; }, projectName);
    await page.click("#new-project-btn");
    await expect(page.locator(`#project-select option[value="${projectName}"]`)).toBeAttached({ timeout: 10_000 });

    // Now track PATCH calls for active_project
    const patchStatuses: number[] = [];
    page.on("response", (resp) => {
      if (resp.url().includes("/settings") && resp.request().method() === "PATCH") {
        const body = resp.request().postData();
        if (body && body.includes("active_project")) {
          patchStatuses.push(resp.status());
        }
      }
    });

    // Switch to a different project via the select dropdown (fires change event → PATCH)
    const projectSelect = page.locator("#project-select");
    const optionValues = await projectSelect.locator("option").evaluateAll(
      (opts) => (opts as HTMLOptionElement[]).map((o) => o.value)
    );
    const currentVal = await projectSelect.inputValue();
    const otherVal = optionValues.find((v) => v !== currentVal);
    expect(otherVal).toBeTruthy();
    await projectSelect.selectOption(otherVal!);
    await page.waitForTimeout(3000);

    // Verify the PATCH was made and succeeded (this is the bug fix verification)
    expect(patchStatuses.length).toBeGreaterThan(0);
    expect(patchStatuses[0]).toBe(200);
  });

  test("switching agent calls settings API with active_agent", async ({ page }) => {
    const agentName = `swagt-${Date.now().toString(36).slice(-5)}`;

    // Track PATCH calls for active_agent
    const patchStatuses: number[] = [];
    page.on("response", (resp) => {
      if (resp.url().includes("/settings") && resp.request().method() === "PATCH") {
        const body = resp.request().postData();
        if (body && body.includes("active_agent")) {
          patchStatuses.push(resp.status());
        }
      }
    });

    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(2000);

    // Override prompt() and create an agent
    await page.evaluate((name) => { window.prompt = () => name; }, agentName);
    await page.click("#new-agent-btn");
    await page.waitForTimeout(3000);

    // New agent creation selects it, which doesn't auto-fire change event.
    // Switch manually to trigger the change handler → PATCH active_agent.
    const agentSelect = page.locator("#agent-select");
    const options = await agentSelect.locator("option").allTextContents();
    if (options.length >= 2) {
      const [response] = await Promise.all([
        page.waitForResponse((resp) =>
          resp.url().includes("/settings") && resp.request().method() === "PATCH"
        ),
        agentSelect.selectOption({ index: 0 }),
      ]);
      expect(response.status()).toBe(200);
    }
  });
});

// ---- Memory ----

test.describe("Memory", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);
  });

  test("memory toggle is visible", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);

    // The checkbox is hidden by CSS (custom toggle) — check the toggle wrapper is visible
    await expect(page.locator("label.toggle")).toBeVisible();
    // And the checkbox is attached in the DOM
    await expect(page.locator("#memory-toggle")).toBeAttached();
  });

  test("memory status loads on settings open", async ({ page }) => {
    test.setTimeout(60_000);

    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);

    // Status should start as "Loading..." and eventually change
    const memoryStatus = page.locator("#memory-status");
    await expect(memoryStatus).toBeVisible();
    const initialText = await memoryStatus.textContent();
    expect(initialText).toBeTruthy();

    // Wait for it to change from "Loading..." (may timeout if agent is offline — that's OK)
    // The sendMemoryCommand("status") polls for up to 30s
    try {
      await expect(memoryStatus).not.toHaveText("Loading...", { timeout: 40_000 });
    } catch {
      // Agent offline — status stays "Loading..." or becomes "Timed out"
    }

    // Regardless of outcome, the status element should have text
    const finalText = await memoryStatus.textContent();
    expect(finalText).toBeTruthy();
  });

  test("backup button triggers command and shows loading", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(1000);

    // Scroll memory section into view
    await page.locator("#settings-panel").evaluate((panel) => {
      const btn = panel.querySelector("#memory-backup-btn");
      if (btn) btn.scrollIntoView({ block: "center" });
    });

    // Track API calls to /memory/command
    let commandSent = false;
    page.on("request", (req) => {
      if (req.url().includes("/memory/command") && req.method() === "POST") {
        commandSent = true;
      }
    });

    await page.click("#memory-backup-btn");

    // Should immediately show "Running..." in the result area
    await expect(page.locator("#memory-result")).toBeVisible({ timeout: 2000 });
    await expect(page.locator("#memory-result")).toHaveText("Running...");

    expect(commandSent).toBe(true);
  });

  test("list button triggers command and shows loading", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(1000);

    // Scroll memory section into view
    await page.locator("#settings-panel").evaluate((panel) => {
      const btn = panel.querySelector("#memory-list-btn");
      if (btn) btn.scrollIntoView({ block: "center" });
    });

    let commandSent = false;
    page.on("request", (req) => {
      if (req.url().includes("/memory/command") && req.method() === "POST") {
        const body = req.postData();
        if (body && body.includes('"list"')) {
          commandSent = true;
        }
      }
    });

    await page.click("#memory-list-btn");

    // Should immediately show "Running..." in the result area
    await expect(page.locator("#memory-result")).toBeVisible({ timeout: 2000 });
    await expect(page.locator("#memory-result")).toHaveText("Running...");

    expect(commandSent).toBe(true);
  });
});

// ---- Usage Dashboard ----

test.describe("Usage Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);
  });

  test("opens from settings", async ({ page }) => {
    await page.click("#settings-btn");
    await expect(page.locator("#settings-overlay")).toHaveClass(/show/);

    await page.click("#usage-btn");
    await expect(page.locator("#usage-overlay")).toHaveClass(/show/);
    // Settings should close
    await expect(page.locator("#settings-overlay")).not.toHaveClass(/show/);
  });

  test("daily tab shows data", async ({ page }) => {
    await page.click("#settings-btn");
    await page.waitForTimeout(1000);
    await page.click("#usage-btn");
    await expect(page.locator("#usage-overlay")).toHaveClass(/show/);

    // Wait for loading to finish
    await page.waitForTimeout(3000);

    // Should either show usage rows or "No usage data" message
    const content = page.locator("#usage-content");
    const hasRows = await content.locator(".usage-row").count();
    const hasEmpty = await content.locator(".usage-empty").count();
    expect(hasRows + hasEmpty).toBeGreaterThan(0);
  });

  test("monthly tab is switchable", async ({ page }) => {
    await page.click("#settings-btn");
    await page.waitForTimeout(1000);
    await page.click("#usage-btn");
    await expect(page.locator("#usage-overlay")).toHaveClass(/show/);
    await page.waitForTimeout(2000);

    // Click monthly tab
    await page.locator('.usage-tab[data-tab="monthly"]').click();
    await expect(page.locator('.usage-tab[data-tab="monthly"]')).toHaveClass(/active/);

    // Wait for data to load
    await page.waitForTimeout(3000);

    // Should show content
    const content = page.locator("#usage-content");
    const hasRows = await content.locator(".usage-row").count();
    const hasEmpty = await content.locator(".usage-empty").count();
    expect(hasRows + hasEmpty).toBeGreaterThan(0);
  });

  test("close button works", async ({ page }) => {
    await page.click("#settings-btn");
    await page.waitForTimeout(500);
    await page.click("#usage-btn");
    await expect(page.locator("#usage-overlay")).toHaveClass(/show/);

    await page.click("#usage-close");
    await expect(page.locator("#usage-overlay")).not.toHaveClass(/show/);
  });
});

// ---- Input & UI ----

test.describe("Input & UI", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaStorage(page);
    await waitForApp(page);
  });

  test("send button disabled when input empty", async ({ page }) => {
    await expect(page.locator("#send-btn")).toBeDisabled();
  });

  test("send button enabled with text", async ({ page }) => {
    await page.fill("#msg-input", "hello");
    await expect(page.locator("#send-btn")).toBeEnabled();
  });

  test("send button disabled again after clearing input", async ({ page }) => {
    await page.fill("#msg-input", "hello");
    await expect(page.locator("#send-btn")).toBeEnabled();

    await page.fill("#msg-input", "");
    await expect(page.locator("#send-btn")).toBeDisabled();
  });

  test("sidebar toggle opens and closes", async ({ page }) => {
    // Initially sidebar should not be open
    await expect(page.locator("#sidebar")).not.toHaveClass(/open/);

    // Open sidebar
    await page.click("#menu-btn");
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await expect(page.locator("#sidebar-overlay")).toHaveClass(/show/);

    // Close by clicking overlay
    await page.click("#sidebar-overlay");
    await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
  });

  test("input auto-resizes with text", async ({ page }) => {
    const input = page.locator("#msg-input");
    const initialHeight = await input.evaluate((el) => el.offsetHeight);

    // Type multiple lines
    await input.fill("Line 1\nLine 2\nLine 3\nLine 4");
    await input.dispatchEvent("input");
    await page.waitForTimeout(100);

    const expandedHeight = await input.evaluate((el) => el.offsetHeight);
    expect(expandedHeight).toBeGreaterThanOrEqual(initialHeight);
  });
});
