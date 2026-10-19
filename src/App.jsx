import { Navigate, Route, Routes } from 'react-router-dom';
import Nav from './components/Nav.jsx';
import Footer from './components/Footer.jsx';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Account from './pages/Account.jsx';
import Admin from './pages/Admin.jsx';
import Feed from './pages/Feed.jsx';
import Compose from './pages/Compose.jsx';

export default function App() {
  return (
    <div className="app">
      <div className="grid-bg" aria-hidden="true" />
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/account" element={<Account />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/compose" element={<Compose />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
