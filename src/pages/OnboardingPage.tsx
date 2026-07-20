import { Link } from 'react-router-dom';

export function OnboardingPage() {
  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white p-4">
      <h1 className="text-xl font-bold text-neutral-800">はじめまして！</h1>
      <p className="mt-2 text-sm text-neutral-500">
        レベル診断テストがここに表示されます（M6で実装）。
      </p>
      <Link to="/" className="mt-4 text-sm text-hana-600 underline">
        ホームへ進む
      </Link>
    </div>
  );
}
