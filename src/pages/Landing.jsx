import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import Hero from '../components/Hero.jsx';
import StatsBar from '../components/StatsBar.jsx';
import Features from '../components/Features.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import Waitlist from '../components/Waitlist.jsx';

export default function Landing() {
  const { hash } = useLocation();

  // Cross-page links arrive as "/#features" — scroll once the section exists.
  useEffect(() => {
    if (!hash) return;
    const el = document.querySelector(hash);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  return (
    <>
      <Hero />
      <StatsBar />
      <Features />
      <HowItWorks />
      <Waitlist />
    </>
  );
}
