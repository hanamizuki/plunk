import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

type Negotiated = 'markdown' | 'html' | 'none';

function parseAccept(accept: string): Array<{ type: string; q: number }> {
  return accept.split(',').map(part => {
    const segments = part.trim().split(';');
    const type = segments[0]?.trim().toLowerCase() ?? '';
    const qParam = segments.slice(1).find(s => s.trim().startsWith('q='));
    const q = qParam ? parseFloat(qParam.split('=')[1] ?? '1') : 1;
    return { type, q: isNaN(q) ? 1 : q };
  });
}

function getQ(types: Array<{ type: string; q: number }>, target: string): number {
  const exact = types.find(t => t.type === target);
  if (exact) return exact.q;
  const [main] = target.split('/');
  const sub = types.find(t => t.type === `${main}/*`);
  if (sub) return sub.q;
  const wildcard = types.find(t => t.type === '*/*');
  return wildcard ? wildcard.q : -1;
}

function negotiate(accept: string): Negotiated {
  if (!accept) return 'html';
  const types = parseAccept(accept);
  const mdQ = types.find(t => t.type === 'text/markdown')?.q ?? -1;
  const htmlQ = getQ(types, 'text/html');
  if (mdQ <= 0 && htmlQ <= 0) return 'none';
  if (mdQ > 0 && mdQ >= htmlQ) return 'markdown';
  return 'html';
}

export function middleware(request: NextRequest) {
  const accept = request.headers.get('accept') ?? '';
  const { pathname } = request.nextUrl;

  if (pathname.endsWith('.md')) {
    const rewriteUrl = new URL(`/llms.mdx${pathname.slice(0, -3)}`, request.url);
    return NextResponse.rewrite(rewriteUrl);
  }

  const result = negotiate(accept);

  if (result === 'none') {
    return new NextResponse(null, { status: 406, headers: { 'Vary': 'Accept' } });
  }

  if (result === 'markdown') {
    const rewriteUrl = new URL(`/llms.mdx${pathname}`, request.url);
    const response = NextResponse.rewrite(rewriteUrl);
    response.headers.set('Vary', 'Accept');
    return response;
  }

  const response = NextResponse.next();
  response.headers.set('Vary', 'Accept');
  response.headers.append('Link', `<${pathname}.md>; rel="alternate"; type="text/markdown"`);
  return response;
}

export const config = {
  matcher: ['/((?!llms\\.mdx|api/search|openapi\\.json|_next|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|css|js|json|xml|txt|webmanifest)).*)',],
};
