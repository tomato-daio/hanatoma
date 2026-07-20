import { Link, useParams } from 'react-router-dom';

export function TalkPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white p-4">
      <h1 className="text-xl font-bold text-neutral-800">会話</h1>
      <p className="mt-2 text-sm text-neutral-500">
        会話画面（id: {conversationId}）。M3で実装します。
      </p>
      <Link to="/" className="mt-4 text-sm text-hana-600 underline">
        ホームへ戻る
      </Link>
    </div>
  );
}
