import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const AuthContext = createContext(null);

/** fetch wrapper that returns { status, data } and never throws on 4xx/5xx. */
export async function apiFetch(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export function AuthProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [encryptionKey, setEncryptionKey] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { status, data } = await apiFetch('/api/auth/me');
      setAccount(status === 200 && data?.account ? data.account : null);
    } catch {
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* even if the call fails, drop the local session state */
    }
    setAccount(null);
    setEncryptionKey(null);
  }, []);

  return (
    <AuthContext.Provider value={{ account, encryptionKey, loading, refresh, logout, setEncryptionKey }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
