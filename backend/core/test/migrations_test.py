import pathlib
import sqlite3
import unittest

MIGRATION = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0001_core.sql'
MAIL_DRAFTS = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0002_mail_drafts.sql'
FAX_INTENTS = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0003_fax_intents.sql'
MAIL_INTENTS = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0004_mail_intents.sql'
MAIL_UNRESOLVED = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0005_mail_unresolved_actor.sql'
MAIL_ACK = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0006_mail_acknowledgement.sql'
MAIL_MODE = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0009_mail_provider_mode.sql'

class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript(MIGRATION.read_text())
        self.db.execute("INSERT INTO jobs VALUES ('j','a','now')")
        self.db.execute("INSERT INTO deliveries VALUES ('d','j','fax',1,'draft',NULL,NULL,'now')")

    def test_constraints_and_immutability(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO deliveries VALUES ('x','j','voice',1,'draft',NULL,NULL,'now')")
        self.db.execute("INSERT INTO document_revisions VALUES ('r','doc','hash','object','now')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE document_revisions SET content_hash='new' WHERE id='r'")

    def test_reservation_uniqueness(self):
        sql = "INSERT INTO submission_intents VALUES (?,?,?,?,?,?,?,NULL)"
        self.db.execute(sql, ('a','submit','d','key','hash',1,'now'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql, ('b','submit','d','other','hash',1,'now'))
        self.db.execute(sql, ('a','submit','d','new','hash',2,'now'))

    def test_mail_draft_owner_and_optimistic_revision(self):
        self.db.executescript(MAIL_DRAFTS.read_text())
        self.db.execute("INSERT INTO mail_drafts VALUES (?,?,?,?,?,?)", ('d', 'owner', 1, '{}', 'now', 'now'))
        update = "UPDATE mail_drafts SET content_json=?, revision=revision+1, updated_at=? WHERE id=? AND actor_id=? AND revision=?"
        self.assertEqual(self.db.execute(update, ('{"text":"first"}', 'later', 'd', 'other', 1)).rowcount, 0)
        self.assertEqual(self.db.execute(update, ('{"text":"first"}', 'later', 'd', 'owner', 1)).rowcount, 1)
        self.assertEqual(self.db.execute(update, ('{}', 'later', 'd', 'owner', 1)).rowcount, 0)
        self.assertEqual(self.db.execute('SELECT revision, content_json FROM mail_drafts').fetchone(), (2, '{"text":"first"}'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO mail_drafts VALUES ('invalid','owner',1,'not json','now','now')")

    def test_mail_intent_upgrade_preserves_drafts_and_single_claim(self):
        self.db.executescript(MAIL_DRAFTS.read_text())
        self.db.executescript(FAX_INTENTS.read_text())
        self.db.execute("INSERT INTO mail_drafts VALUES (?,?,?,?,?,?)", ('d', 'owner', 1, '{}', 'now', 'now'))
        self.db.executescript(MAIL_INTENTS.read_text())
        self.assertEqual(self.db.execute('SELECT content_json FROM mail_drafts WHERE id=?', ('d',)).fetchone(), ('{}',))
        values = ('d', 'owner', 1, 'hash', '{}', 'submitting', None, 'now', 'now')
        self.db.execute('INSERT INTO mail_intents VALUES (?,?,?,?,?,?,?,?,?)', values)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO mail_intents VALUES (?,?,?,?,?,?,?,?,?)', values)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE mail_intents SET status='retry'")
        self.db.executescript(MAIL_UNRESOLVED.read_text())
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO mail_intents VALUES (?,?,?,?,?,?,?,?,?)', ('d2', 'owner', 1, 'hash', '{}', 'unknown', None, 'now', 'now'))
        self.db.execute("UPDATE mail_intents SET status='accepted' WHERE draft_id='d'")
        self.db.execute('INSERT INTO mail_intents VALUES (?,?,?,?,?,?,?,?,?)', ('d2', 'owner', 1, 'hash', '{}', 'unknown', None, 'now', 'now'))

    def test_mail_migration_names_are_contiguous_and_unambiguous(self):
        names = sorted(p.name for p in MAIL_INTENTS.parent.glob('*.sql'))
        self.assertEqual([n for n in names if n.startswith(('0004_', '0005_', '0006_'))],
                         ['0004_mail_intents.sql', '0005_mail_unresolved_actor.sql', '0006_mail_acknowledgement.sql'])
        self.assertNotIn('0008_mail_acknowledgement.sql', names)

    def test_unresolved_index_refuses_existing_conflicts_without_discarding_rows(self):
        self.db.executescript(MAIL_INTENTS.read_text())
        for draft in ('d1', 'd2'):
            self.db.execute('INSERT INTO mail_intents VALUES (?,?,?,?,?,?,?,?,?)', (draft, 'owner', 1, 'hash', '{}', 'unknown', None, 'now', 'now'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.executescript(MAIL_UNRESOLVED.read_text())
        self.assertEqual(self.db.execute('SELECT count(*) FROM mail_intents').fetchone(), (2,))

    def test_unacknowledged_acceptance_blocks_until_acknowledged(self):
        self.db.executescript(MAIL_INTENTS.read_text())
        self.db.executescript(MAIL_UNRESOLVED.read_text())
        self.db.executescript(MAIL_ACK.read_text())
        insert = 'INSERT INTO mail_intents (draft_id,actor_id,revision,review_hash,payload_json,status,provider_id,confirmed_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
        self.db.execute(insert, ('d', 'owner', 1, 'hash', '{}', 'accepted', 'letter_1', 'now', 'now'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ('d2', 'owner', 1, 'hash', '{}', 'submitting', None, 'now', 'now'))
        self.db.execute("UPDATE mail_intents SET acknowledged_at='now' WHERE draft_id='d'")
        self.db.execute(insert, ('d2', 'owner', 1, 'hash', '{}', 'submitting', None, 'now', 'now'))

    def test_ack_migration_conflict_keeps_existing_gate_and_rows(self):
        self.db.executescript(MAIL_INTENTS.read_text())
        self.db.executescript(MAIL_UNRESOLVED.read_text())
        for draft in ('d1', 'd2'):
            self.db.execute('INSERT INTO mail_intents VALUES (?,?,?,?,?,?,?,?,?)', (draft, 'owner', 1, 'hash', '{}', 'accepted', 'letter_1', 'now', 'now'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.executescript(MAIL_ACK.read_text())
        self.assertEqual(self.db.execute('SELECT count(*) FROM mail_intents').fetchone(), (2,))
        self.assertIsNotNone(self.db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='mail_one_unresolved_per_actor'").fetchone())

    def test_mode_upgrade_preserves_claims_and_cross_mode_gate(self):
        for migration in (MAIL_INTENTS, MAIL_UNRESOLVED, MAIL_ACK):
            self.db.executescript(migration.read_text())
        insert = 'INSERT INTO mail_intents (draft_id,actor_id,revision,review_hash,payload_json,status,provider_id,confirmed_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
        self.db.execute(insert, ('accepted', 'owner1', 1, 'hash', '{}', 'accepted', 'letter_1', 'now', 'now'))
        self.db.execute(insert, ('unknown', 'owner2', 1, 'hash', '{}', 'unknown', None, 'now', 'now'))
        self.db.executescript(MAIL_MODE.read_text())
        self.assertEqual(self.db.execute('SELECT draft_id, provider_mode FROM mail_intents ORDER BY draft_id').fetchall(), [('accepted', 'live'), ('unknown', 'live')])
        insert_mode = 'INSERT INTO mail_intents (draft_id,actor_id,revision,review_hash,payload_json,status,confirmed_at,updated_at,provider_mode) VALUES (?,?,?,?,?,?,?,?,?)'
        for actor in ('owner1', 'owner2'):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(insert_mode, ('new-' + actor, actor, 1, 'hash', '{}', 'submitting', 'now', 'now', 'test'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE mail_intents SET provider_mode='invalid' WHERE draft_id='accepted'")
        self.assertEqual(self.db.execute('SELECT count(*) FROM mail_intents').fetchone(), (2,))

if __name__ == '__main__':
    unittest.main()
