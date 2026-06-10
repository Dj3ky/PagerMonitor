import { useState, useRef, useEffect, useCallback } from 'react';
import { postUserLocation, deleteUserLocation } from '../utils/api.js';

const STORAGE_KEY  = 'pm_location_prompt';  // 'granted' | 'declined'
const POSITION_KEY = 'pm_last_position';    // { lat, lng } cached from last session

function loadCachedPosition() {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== 'granted') return null;
    const raw = localStorage.getItem(POSITION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function useLocationSharing(user) {
  const [state,    setState]    = useState('idle'); // 'idle'|'asking'|'active'|'denied'
  const [position, setPosition] = useState(loadCachedPosition); // pre-fill from cache
  const [showPrompt, setShowPrompt] = useState(false);

  const intervalRef = useRef(null);

  // Decide whether to show the first-open prompt
  useEffect(() => {
    if (!user || user.isGuest) return;
    if (!navigator.geolocation) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) setShowPrompt(true);
    else if (stored === 'granted') start(); // auto-resume if previously allowed
  }, [user?.id]);

  const sendPos = useCallback((pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    postUserLocation(lat, lng).catch(() => {});
    const newPos = { lat, lng };
    localStorage.setItem(POSITION_KEY, JSON.stringify(newPos));
    setPosition(newPos);
    setState('active');
  }, []);

  const start = useCallback(() => {
    if (!navigator.geolocation) { setState('denied'); return; }
    setState('asking');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        sendPos(pos);
        clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => {
          navigator.geolocation.getCurrentPosition(sendPos, () => {}, { timeout: 10000, enableHighAccuracy: true });
        }, 30_000);
      },
      () => {
        setState('denied');
        localStorage.setItem(STORAGE_KEY, 'declined');
        localStorage.removeItem(POSITION_KEY);
        setShowPrompt(false);
      },
      { timeout: 15000, enableHighAccuracy: true }
    );
  }, [sendPos]);

  const stop = useCallback(() => {
    clearInterval(intervalRef.current);
    deleteUserLocation().catch(() => {});
    localStorage.removeItem(POSITION_KEY);
    setPosition(null);
    setState('idle');
  }, []);

  const acceptPrompt = useCallback(() => {
    setShowPrompt(false);
    localStorage.setItem(STORAGE_KEY, 'granted');
    start();
  }, [start]);

  const declinePrompt = useCallback(() => {
    setShowPrompt(false);
    localStorage.setItem(STORAGE_KEY, 'declined');
  }, []);

  // Cleanup on unmount
  useEffect(() => () => clearInterval(intervalRef.current), []);

  return { state, position, showPrompt, start, stop, acceptPrompt, declinePrompt };
}
