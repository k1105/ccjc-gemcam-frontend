// Vercel版 /api/generate。会場PC専用のローカルraw/generated保存(local-store.js)は行わない。
import { verifyAllowedUser } from '../server/auth.js';
import { runGenerate } from '../server/generate-handler.js';

export async function POST(request) {
  try {
    await verifyAllowedUser(request.headers.get('authorization'));
    const { brand: brandSlug, image } = await request.json();
    const result = await runGenerate({ brandSlug, image });
    return Response.json(result);
  } catch (err) {
    console.error('[api/generate] error:', err);
    return Response.json({ error: err.message || '生成に失敗しました' }, { status: err.status || 500 });
  }
}
