// フロントのログインゲートがGoogleサインイン直後に呼ぶ。
// Authorization: Bearer <idToken> を検証し、ALLOWED_EMAILS 内なら { ok: true, email } を返す。
import { verifyAllowedUser } from '../../server/auth.js';

export async function POST(request) {
  try {
    const { email } = await verifyAllowedUser(request.headers.get('authorization'));
    return Response.json({ ok: true, email });
  } catch (err) {
    return Response.json({ error: err.message || '認証に失敗しました' }, { status: err.status || 500 });
  }
}
