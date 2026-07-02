// firebase非依存の軽量ヘルパ。main.js/api.js から静的importしても
// ローカル会場PCビルドのバンドルにfirebaseを含めずに済む（auth-gate.js は動的importのみで読む）。
export function isAuthRequired() {
  return import.meta.env.VITE_REQUIRE_AUTH === '1';
}
