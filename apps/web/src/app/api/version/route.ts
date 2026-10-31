import { NextResponse } from 'next/server';
import { BUILD } from '@/lib/build';

/** Which build is answering. `StaleBuildGuard` compares this with the document it was served. */
export async function GET() {
  return NextResponse.json({ build: BUILD }, { headers: { 'cache-control': 'no-store' } });
}
