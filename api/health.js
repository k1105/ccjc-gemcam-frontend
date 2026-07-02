// Vercel版ヘルスチェック。認証不要・公開。
// キー管理(server/api-keys.js)はローカル運用専用のため keyCount 等は含めない。
import { getProvider, getModel } from '../server/provider.js';
import { brands } from '../server/brands.js';

export async function GET() {
  return Response.json({
    ok: true,
    provider: getProvider(),
    model: getModel(),
    mock: process.env.MOCK_GENERATION === 'true',
    brands: brands.map((b) => b.slug),
  });
}
