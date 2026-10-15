import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as fitbot


class FitBotAppTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.original_data_file = fitbot.app.config['DATA_FILE']
        self.original_secret_key = fitbot.app.config['SECRET_KEY']
        fitbot.app.config.update(
            TESTING=True,
            DATA_FILE=str(Path(self.temp_dir.name) / 'fitbot_data.json'),
            SECRET_KEY='test-only-session-secret',
            OPENROUTER_API_KEY='',
        )
        fitbot.init_store()
        self.client = fitbot.app.test_client()

    def tearDown(self):
        fitbot.app.config['DATA_FILE'] = self.original_data_file
        fitbot.app.config['SECRET_KEY'] = self.original_secret_key
        self.temp_dir.cleanup()

    def create_account(self, client=None, username='demo-user'):
        client = client or self.client
        return client.post('/signup', data={'username': username, 'password': 'secure-demo-password'})

    def test_signup_shows_persisted_starter_conversation_and_login_restores_it(self):
        response = self.create_account()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers['Location'], '/chat')

        page = self.client.get('/chat')
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'A simple sleep routine', page.data)
        self.assertIn(fitbot.STARTER_EXCHANGE[0].encode(), page.data)
        self.assertIn(fitbot.STARTER_EXCHANGE[1].encode(), page.data)
        self.assertIn(b'fitbot-chat-ui-v8', page.data)

        self.client.post('/logout')
        self.assertEqual(self.client.get('/chat').status_code, 302)
        login = self.client.post(
            '/login',
            data={'username': 'demo-user', 'password': 'secure-demo-password'},
        )
        self.assertEqual(login.status_code, 302)
        restored = self.client.get('/chat')
        self.assertIn(fitbot.STARTER_EXCHANGE[0].encode(), restored.data)
        store = fitbot.load_store()
        self.assertEqual(len(store['conversations']), 1)
        self.assertEqual(len(store['messages']), 2)

    def test_stale_session_is_cleared_and_redirected_to_login(self):
        with self.client.session_transaction() as session:
            session['user_id'] = 999
            session['unrelated'] = 'stale'

        response = self.client.get('/chat')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers['Location'], '/login')
        with self.client.session_transaction() as session:
            self.assertEqual(dict(session), {})

    def test_streamed_ollama_fallback_persists_one_synchronized_exchange(self):
        self.create_account()
        fitbot.app.config['OPENROUTER_API_KEY'] = 'test-only-key'

        def interrupted_primary(*_args, **_kwargs):
            yield 'This incomplete OpenRouter text must be cleared before the local reply appears. ' * 3
            raise fitbot.ModelStreamError('offline', 'provider stream ended early')

        def local_reply(*_args, **_kwargs):
            yield 'Try a steady sleep and wake time.'
            yield ' If this persists, speak with a clinician.'

        with patch.object(fitbot, 'stream_openrouter', side_effect=interrupted_primary):
            with patch.object(fitbot, 'stream_ollama', side_effect=local_reply):
                response = self.client.post(
                    '/api/chat',
                    data={
                        'conversation_id': '1',
                        'user_input': 'How can I sleep better?',
                        'language': 'en-IN',
                    },
                    buffered=True,
                )

        events = [json.loads(line) for line in response.data.decode().splitlines()]
        done = next(event for event in events if event['type'] == 'done')
        expected_reply = 'Try a steady sleep and wake time. If this persists, speak with a clinician.'
        event_types = [event['type'] for event in events]
        self.assertIn('reset', event_types)
        reset_index = event_types.index('reset')
        self.assertGreater(event_types.index('token', reset_index), reset_index)
        visible_reply = ''
        for event in events:
            if event['type'] == 'reset':
                visible_reply = ''
            elif event['type'] == 'token':
                visible_reply += event.get('content', '')
        self.assertEqual(visible_reply, expected_reply)
        self.assertEqual(done['provider'], 'ollama')
        self.assertIsNone(done['error'])
        self.assertEqual(done['assistant_message'], expected_reply)
        self.assertEqual([item['role'] for item in done['messages'][-2:]], ['user', 'assistant'])
        self.assertEqual(done['messages'][-1]['content'], expected_reply)

    def test_ollama_stream_uses_non_thinking_chat_payload_and_waits_for_done(self):
        class FakeResponse:
            status_code = 200
            encoding = None

            def raise_for_status(self):
                return None

            def iter_lines(self, decode_unicode=False):
                yield json.dumps({'message': {'content': 'A clear reply.'}}).encode()
                yield json.dumps({'done': True, 'done_reason': 'stop'}).encode()

            def close(self):
                pass

        with patch.object(fitbot.requests, 'post', return_value=FakeResponse()) as post:
            chunks = list(fitbot.stream_ollama([], 'Hello', 'en-IN'))

        self.assertEqual(chunks, ['A clear reply.'])
        payload = post.call_args.kwargs['json']
        self.assertTrue(payload['stream'])
        self.assertIs(payload['think'], False)
        self.assertEqual(payload['messages'][-1], {'role': 'user', 'content': 'Hello'})


if __name__ == '__main__':
    unittest.main()
