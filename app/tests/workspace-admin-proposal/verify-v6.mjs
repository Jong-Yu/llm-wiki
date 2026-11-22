import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const out = new URL("./verification/admin-console-v6/", import.meta.url);
await mkdir(out, { recursive: true });
const fragmentPath =
  process.argv[2] ??
  "/Users/jong-yu/.codex/visualizations/2026/11/16/01a1e40f-f625-7490-83c9-cc57a80aea09/workspace-admin.html";
const temporary = await mkdtemp("/private/tmp/wiki-admin-v6-");
const fragment = await readFile(fragmentPath, "utf8");
const url = `file://${temporary}/admin.html`;
await writeFile(
  `${temporary}/admin.html`,
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${fragment}</body></html>`,
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const checks = [],
  errors = [],
  requests = [],
  screenshots = [],
  snapshots = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
});
await page.addInitScript(() => {
  window.snapshots = [];
  window.openai = {
    widgetState: {
      privateContent: { version: 5, path: "/admin/workspaces", stress: false, searches: {} },
    },
    setWidgetState: async (value) => {
      window.snapshots.push(structuredClone(value));
    },
  };
});
const check = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
const button = (name) => page.getByRole("button", { name, exact: true });
const list = (label) => page.getByRole("list", { name: `${label} 결과`, exact: true });
const ready = async (label) => {
  await expect(list(label)).toBeVisible();
  await expect(page.getByText("검색 중…", { exact: true })).toHaveCount(0);
};
const collect = async () => snapshots.push(...(await page.evaluate(() => window.snapshots ?? [])));
const reset = async () => {
  await collect();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
};
const setting = async (label, value) => {
  const control = page.getByLabel(label, { exact: true });
  const summary = page.locator("summary").filter({ hasText: "시안 설정" });
  if (!(await control.isVisible())) await summary.click();
  if (typeof value === "boolean") await control.setChecked(value);
  else await control.selectOption(value);
  await summary.click();
};
const shot = async (name) => {
  await page.mouse.move(0, 0);
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await page.screenshot({
    path: fileURLToPath(new URL(`${name}.png`, out)),
    fullPage: true,
    animations: "disabled",
  });
  screenshots.push(`${name}.png`);
};
const noAdminDom = async (surface = page) => {
  await expect(
    surface.getByRole("navigation", { name: "관리 탐색", includeHidden: true }),
  ).toHaveCount(0);
  for (const name of ["워크스페이스 목록 결과", "사용자 목록 결과", "변경 이력 결과"])
    await expect(surface.getByRole("list", { name, exact: true, includeHidden: true })).toHaveCount(
      0,
    );
  await expect(surface.locator('[data-screen^="/admin/"]')).toHaveCount(0);
};
const noOverflow = async (context) =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    context,
  );
const authForm = () => page.getByRole("form", { name: "관리자 로그인", exact: true });
const keyInput = () => authForm().getByLabel("관리자 키", { exact: true });
const submitKey = async (key = "demo-admin") => {
  await keyInput().fill(key);
  await authForm().getByRole("button", { name: "관리자 로그인", exact: true }).click();
};
const enterFromLogin = async () => {
  await button("관리자 로그인").click();
  await expect(authForm()).toBeVisible();
};
const ordinaryState = async () => page.evaluate(() => window.wiki.connection.getState());

try {
  await reset();
  await noAdminDom();

  await expect(page.getByRole("textbox", { name: "계정 이름", exact: true })).toBeVisible();
  await shot("login-entry-light-1280");
  await button("관리자 로그인").focus();
  await page.keyboard.press("Enter");
  await expect(authForm()).toBeVisible();
  await expect(keyInput()).toBeFocused();
  await noAdminDom();
  await expect(page.getByRole("textbox", { name: "계정 이름", exact: true })).toHaveCount(0);
  await expect(page.locator("input[value=signup]")).toHaveCount(0);
  await expect(authForm().getByLabel("서버 주소", { exact: true })).toHaveValue(
    "https://wiki.example.com",
  );
  await shot("admin-auth-light-1280");
  await submitKey("wrong-admin");
  await expect(
    page.getByText("입력한 키로 인증할 수 없습니다. 다시 입력해 주세요.", { exact: true }),
  ).toBeVisible();
  await expect(keyInput()).toHaveValue("");
  await noAdminDom();
  await shot("admin-invalid-key-light-1280");
  check(
    "로그인 하단에서 키보드로 독립 관리자 인증 진입, 일반 가입·소속 요구 없음, 잘못된 키 거부와 제출 후 입력 비움",
  );

  for (const [mode, title] of [
    ["unconfigured", "관리자 인증이 준비되지 않았습니다"],
    ["offline", "서버에 연결할 수 없습니다"],
    ["denied", "관리 권한을 확인할 수 없습니다"],
  ]) {
    await setting("시안 상태", mode);
    await submitKey();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(keyInput()).toHaveValue("");
    await noAdminDom();
  }
  await setting("시안 상태", "normal");
  await keyInput().fill("demo-admin");
  await authForm().getByRole("button", { name: "관리자 로그인", exact: true }).click();
  await button("돌아가기").click();
  await expect(page.getByRole("textbox", { name: "계정 이름", exact: true })).toBeVisible();
  await expect(button("관리자 로그인")).toBeFocused();
  await page.waitForTimeout(550);
  await noAdminDom();
  await enterFromLogin();
  await expect(keyInput()).toHaveValue("");
  await submitKey();
  await ready("워크스페이스 목록");
  await button("관리 종료").click();
  await expect(page.getByRole("textbox", { name: "계정 이름", exact: true })).toBeVisible();
  await expect(button("관리자 로그인")).toBeFocused();
  await noAdminDom();
  check(
    "미설정·연결 실패·권한 거부 상태 표시, 진행 중 취소 후 늦은 인증 성공 차단, 재진입 키 비움·관리 종료의 원 로그인 복귀",
  );

  await page.getByRole("textbox", { name: "계정 이름", exact: true }).fill("일반 사용자 유지 검증");
  await page
    .getByRole("textbox", { name: "서버 주소", exact: true })
    .fill("https://ordinary.example.test");
  await button("로그인").click();
  const accountPanel = page.getByRole("region", { name: "서버·계정", exact: true });
  await expect(accountPanel).toBeVisible();
  await expect(accountPanel).toContainText("일반 사용자 유지 검증");
  await expect(accountPanel).toContainText("SDV 플랫폼");
  const originalAccount = await ordinaryState();
  await shot("settings-admin-entry-light-1280");
  await button("관리자 콘솔 열기").click();
  await expect(authForm()).toBeVisible();
  await expect(authForm().getByLabel("서버 주소", { exact: true })).toHaveValue(
    "https://ordinary.example.test",
  );
  await keyInput().fill("cancel-key");
  await button("돌아가기").click();
  await expect(accountPanel).toBeVisible();
  assert.deepEqual(await ordinaryState(), originalAccount);
  await expect(button("관리자 콘솔 열기")).toBeFocused();
  await button("관리자 콘솔 열기").click();
  await expect(keyInput()).toHaveValue("");
  await authForm().getByLabel("서버 주소", { exact: true }).fill("https://admin.example.test");
  await submitKey();
  await ready("워크스페이스 목록");
  assert.deepEqual(await ordinaryState(), originalAccount);
  await expect(page.getByRole("contentinfo", { name: "관리 서버", exact: true })).toContainText(
    "admin.example.test",
  );
  await button("관리 종료").click();
  await expect(accountPanel).toBeVisible();
  await expect(button("관리자 콘솔 열기")).toBeFocused();
  await expect(accountPanel).toContainText("일반 사용자 유지 검증");
  await expect(accountPanel).toContainText("ordinary.example.test");
  assert.deepEqual(await ordinaryState(), originalAccount);
  check(
    "설정 서버·계정의 서버 관리 행에서 독립 인증, 취소·관리 종료 뒤 원 이름·서버·소속과 일반 연결 스냅샷 보존",
  );

  await reset();
  await page
    .locator("label")
    .filter({ has: page.locator("input[value=signup]") })
    .click();
  await page.getByRole("textbox", { name: "계정 이름", exact: true }).fill("미배정 사용자 검증");
  await button("가입하고 시작").click();
  await expect(
    page.getByRole("heading", { name: "워크스페이스 배정 대기", exact: true }),
  ).toBeVisible();
  await noAdminDom();
  await shot("waiting-admin-entry-light-1280");
  await enterFromLogin();
  await submitKey();
  await ready("워크스페이스 목록");
  await button("관리 종료").click();
  await expect(
    page.getByRole("heading", { name: "워크스페이스 배정 대기", exact: true }),
  ).toBeVisible();
  await expect(button("관리자 로그인")).toBeFocused();
  await button("워크스페이스 배정 다시 확인").click();
  await expect(
    page.getByText("아직 배정된 워크스페이스가 없습니다.", { exact: true }),
  ).toBeVisible();
  await noAdminDom();
  check(
    "무소속 배정 대기에서도 관리자 인증 가능, 관리 종료 후 일반 계정은 소속 배정 없이 계속 대기",
  );

  const forged = {
    version: 6,
    path: "/admin/user?id=minseo",
    stress: false,
    searches: {},
    trail: [],
    membership: "all",
    filters: {},
    origin: "login",
    adminSession: { accepted: true },
  };
  await reset();
  await page.evaluate(
    (state) =>
      window.dispatchEvent(
        new CustomEvent("openai:set_globals", {
          detail: { globals: { widgetState: { privateContent: state } } },
        }),
      ),
    forged,
  );
  await expect(authForm()).toBeVisible();
  await noAdminDom();
  await expect(keyInput()).toHaveValue("");
  const restorePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  restorePage.on("pageerror", (error) => errors.push(error.message));
  restorePage.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await restorePage.addInitScript((state) => {
    window.openai = { widgetState: { privateContent: state } };
  }, forged);
  await restorePage.goto(`${url}#/admin/workspace?id=sdv-platform`);
  await expect(restorePage.getByRole("form", { name: "관리자 로그인", exact: true })).toBeVisible();
  await noAdminDom(restorePage);
  await restorePage.close();
  check(
    "호스트 상태 복원·외부 상태 이벤트·관리 주소와 위조 세션 필드로 인증 우회 불가, 인증 전 관리 메뉴·자료 DOM 없음",
  );

  await reset();
  await page.clock.install();
  await enterFromLogin();
  await submitKey();
  await ready("워크스페이스 목록");
  await page.clock.fastForward(14 * 60 * 1000);
  await button("SDV 플랫폼 이름 편집").click();
  const workspaceName = page.getByRole("textbox", { name: "워크스페이스 이름", exact: true });
  await workspaceName.fill("재인증 후 유지할 이름");
  await page.clock.fastForward(61 * 1000);
  await expect(page.getByText("관리자 인증이 만료되었습니다", { exact: true })).toBeVisible();
  await expect(keyInput()).toHaveValue("");
  await noAdminDom();
  await shot("admin-expired-light-1280");
  await submitKey();
  await expect(workspaceName).toBeVisible();
  await expect(page.locator('[data-screen="/admin/workspace/edit"]')).toBeVisible();
  await expect(workspaceName).toHaveValue("재인증 후 유지할 이름");
  await button("변경 저장").click();
  await ready("워크스페이스 목록");
  await expect(button("재인증 후 유지할 이름")).toBeVisible();
  await button("관리 종료").click();
  await enterFromLogin();
  await expect(keyInput()).toHaveValue("");
  check(
    "가상시계로 실제 15분 절대 만료와 활동 시 연장 없음 확인, 관리 DOM 제거 및 재인증 뒤 같은 이름 편집·초안 복원·저장",
  );

  for (const width of [1280, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(authForm()).toBeVisible();
    await noOverflow(`auth ${width}`);
    await expect(keyInput()).toBeVisible();
    await expect(button("돌아가기")).toBeVisible();
    await shot(`admin-auth-light-${width}`);
  }
  for (const entry of ["waiting", "settings"]) {
    await setting("진입 화면", entry);
    for (const width of [736, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(`${entry} ${width}`);
      await expect(
        button(entry === "settings" ? "관리자 콘솔 열기" : "관리자 로그인"),
      ).toBeVisible();
      await shot(`${entry}-admin-entry-light-${width}`);
    }
  }
  check(
    "핵심 인증·설정·대기 화면 320/736/1280에서 진입·취소 조작 노출과 가로 넘침 없음, 키보드 진입·입력·취소와 종료 후 원 진입점 focus 복원 확인",
  );

  await collect();
  assert(snapshots.length > 0, "host state was exercised");
  const serialized = JSON.stringify(snapshots);
  assert(!serialized.includes("demo-admin"));
  assert(!serialized.includes("wrong-admin"));
  assert(!serialized.includes("cancel-key"));
  const forbidden = new Set([
    "adminKey",
    "administratorKey",
    "adminSession",
    "adminSessionId",
    "adminAuthenticated",
    "authenticated",
    "token",
  ]);
  const inspect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert(!forbidden.has(key), `private authentication field in host state: ${key}`);
      inspect(nested);
    }
  };
  for (const snapshot of snapshots) {
    inspect(snapshot);
    assert(Buffer.byteLength(JSON.stringify(snapshot)) < 16384);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  check(
    "호스트 상태에 관리자 키·인증 세션 없음, 저장 크기 제한 유지, 브라우저 오류·외부 요청 없음",
  );
  await writeFile(
    new URL("results.json", out),
    JSON.stringify(
      {
        passed: true,
        checks,
        screenshots: [...new Set(screenshots)],
        errors,
        requests,
        verifiedAt: new Date().toISOString(),
        scope:
          "v6 관리자 진입·독립 인증의 모의 화면 검증; 실제 관리자 API·인증 보안 검증 완료 아님",
        previousEvidence: "../admin-console-v5/",
      },
      null,
      2,
    ) + "\n",
  );
  await rm(new URL("failure.png", out), { force: true });
  await rm(new URL("failure.json", out), { force: true });
} catch (error) {
  await page
    .screenshot({ path: fileURLToPath(new URL("failure.png", out)), fullPage: true })
    .catch(() => undefined);
  await writeFile(
    new URL("failure.json", out),
    JSON.stringify(
      {
        passed: false,
        checks,
        error: String(error),
        errors,
        requests,
        text: await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
