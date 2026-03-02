import { initializeApp } from "firebase/app";
import { getStorage } from "firebase/storage";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyANQ0WGu5-B4ck_Sc4h3nSbKmfrr5_ovNw",
  authDomain: "tocc-budget-master.firebaseapp.com",
  projectId: "tocc-budget-master",
  storageBucket: "tocc-budget-master.firebasestorage.app",
  messagingSenderId: "881664185950",
  appId: "1:881664185950:web:a2a8cfe3decd7ba7d646cf",
};

const app = initializeApp(firebaseConfig);

export const storage = getStorage(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-east1");
