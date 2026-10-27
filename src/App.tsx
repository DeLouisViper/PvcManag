import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Spinner } from './components/ui'
import { AuthProvider, useAuth } from './ctx/Auth'
import { DataProvider } from './ctx/Data'
import { ToastProvider } from './ctx/Toast'
import { I18nProvider } from './lib/i18n'
import { Calculator } from './pages/Calculator'
import { ChangePassword } from './pages/ChangePassword'
import { Dashboard } from './pages/Dashboard'
import { History } from './pages/History'
import { Inventory } from './pages/Inventory'
import { Login } from './pages/Login'
import { Settings } from './pages/Settings'
import { Transactions } from './pages/Transactions'
import { Users } from './pages/Users'

function Gate() {
  const { state } = useAuth()
  if (state.status === 'loading') return <div className="flex min-h-full items-center justify-center"><Spinner /></div>
  if (state.status === 'signedOut') return <Login />
  if (state.profile.must_change_password) return <ChangePassword />
  const admin = state.profile.role === 'admin'
  return (
    <DataProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Dashboard />} />
          <Route path="calculator" element={<Calculator />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="history" element={<History />} />
          <Route path="transactions" element={<Transactions />} />
          {/* The UI hides these for standard users; the database enforces it regardless */}
          <Route path="users" element={admin ? <Users /> : <Navigate to="/" replace />} />
          <Route path="settings" element={admin ? <Settings /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </DataProvider>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <HashRouter>
            <div className="crt min-h-full animate-flicker"><Gate /></div>
          </HashRouter>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  )
}
