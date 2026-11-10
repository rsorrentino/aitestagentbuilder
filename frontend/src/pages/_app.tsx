import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { api, getToken } from '../lib/api';
import '../styles/globals.css';

/**
 * When the backend has AUTH_ENABLED=true, every page except /login requires a token.
 */
export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (router.pathname === '/login') {
      setReady(true);
      return;
    }
    api.get('/auth/config')
      .then((res) => {
        if (res.data?.authEnabled && !getToken()) {
          router.replace(`/login?next=${encodeURIComponent(router.asPath)}`);
        } else {
          setReady(true);
        }
      })
      .catch(() => setReady(true)); // backend unreachable: pages show their own error
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.pathname]);

  return (
    <>
      <Head>
        <title>AI Test Agent Builder</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      {ready ? <Component {...pageProps} /> : <div className="page-loading" style={{ height: '100vh' }}><div className="spinner" /></div>}
    </>
  );
}
