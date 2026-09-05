// =========================================================
// manifest.json の検証。
//
//   1.2.0 で変えてよいのは version / default_locale / name / description だけ。
//   権限・OAuth・拡張機能 ID（key）が動いていないことを、値そのもので固定する。
//   ここが落ちたら、Chrome Web Store で新しい権限警告が出るか、
//   拡張機能 ID が変わって Sukima 側の CORS 許可から外れる可能性がある。
// =========================================================

import test from "node:test";
import assert from "node:assert/strict";

import { readExtensionFile } from "./extension-harness.mjs";

const manifest = JSON.parse(readExtensionFile("manifest.json"));

// 公開中 1.0.0 / ドラフト 1.1.0 から一切変えてはいけない値。
const FROZEN = {
  manifest_version: 3,
  key:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkaHPjBXiMfDjYF+gVxrxN1Ntb3PVtDZb80Cnfg83jl03WVS5UhNyWsPfRGRWBCVQPyNVuvk26rAJ8S9A4Y6Q+m4aDnzOVNJSJM4NSGS2h+FfGOPOOeVux/WlbHApj2lLrRT3UUvVZwpNnwaQiiLi6NRFJUlLYUBq/S+SSuTRYuMYwrV2UMe2nov3VKDIR/Yh8j0xneRNU3y6wOb8I9XZJUJJAtRRd1udclKX+YTOq1nCwabdr1fipalD219f9herqyeaKs4dpWIbRSvcjU9MZ7FPtU4xqAV68jr0nuu6i3p/DdKsnzGgCwdCdxuauMN/2XgHRCD1Ns2LU91xPNrS/QIDAQAB",
  permissions: ["sidePanel", "identity"],
  host_permissions: ["https://www.googleapis.com/*"],
  oauth2ClientId: "356365978986-4m0qrnk9f84le0p7mk09bdb1l92rcp5e.apps.googleusercontent.com",
  oauth2Scopes: [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  ],
  sidePanelPath: "sidepanel.html",
  serviceWorker: "background.js",
};

test("version は 1.2.0", () => {
  assert.equal(manifest.version, "1.2.0");
});

test("default_locale は en（未対応言語で英語へ落ちる）", () => {
  assert.equal(manifest.default_locale, "en");
});

test("name と description は __MSG_*__ 参照になっている", () => {
  assert.equal(manifest.name, "__MSG_appName__");
  assert.equal(manifest.description, "__MSG_appDesc__");
});

test("permissions が増えていない（新しい権限警告を出さない）", () => {
  assert.deepEqual(manifest.permissions, FROZEN.permissions);
});

test("host_permissions が増えていない", () => {
  assert.deepEqual(manifest.host_permissions, FROZEN.host_permissions);
});

test("OAuth の client_id と scopes が変わっていない（再審査を発生させない）", () => {
  assert.equal(manifest.oauth2.client_id, FROZEN.oauth2ClientId);
  assert.deepEqual(manifest.oauth2.scopes, FROZEN.oauth2Scopes);
});

test("key が変わっていない（拡張機能 ID を固定する）", () => {
  assert.equal(manifest.key, FROZEN.key);
});

test("manifest_version / side_panel / background が変わっていない", () => {
  assert.equal(manifest.manifest_version, FROZEN.manifest_version);
  assert.equal(manifest.side_panel.default_path, FROZEN.sidePanelPath);
  assert.equal(manifest.background.service_worker, FROZEN.serviceWorker);
});

test("icons と action.default_icon が 16 / 48 / 128 のまま", () => {
  assert.deepEqual(manifest.icons, {
    16: "icon-16.png",
    48: "icon-48.png",
    128: "icon-128.png",
  });
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
});

test("manifest のキー集合が想定どおり（余計なキーが増えていない）", () => {
  assert.deepEqual(Object.keys(manifest).sort(), [
    "action",
    "background",
    "default_locale",
    "description",
    "host_permissions",
    "icons",
    "key",
    "manifest_version",
    "name",
    "oauth2",
    "permissions",
    "side_panel",
    "version",
  ]);
});
