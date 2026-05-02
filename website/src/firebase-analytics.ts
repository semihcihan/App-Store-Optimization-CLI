import { getApps, initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyAnUVZsMYNs1Y51mZFeHQ_gmWiNyIPgcp0",
  authDomain: "aso-cli.firebaseapp.com",
  projectId: "aso-cli",
  storageBucket: "aso-cli.firebasestorage.app",
  messagingSenderId: "353821737266",
  appId: "1:353821737266:web:7181c1a9fc0070db72d72b",
  measurementId: "G-RWW1YBRPEQ",
};

export async function startFirebaseAnalytics() {
  const supported = await isSupported();
  if (!supported) return;

  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  getAnalytics(app);
}
