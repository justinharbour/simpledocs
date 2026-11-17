import pathlib
import sqlite3
import unittest

MIGRATION = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0001_core.sql'
MAIL_DRAFTS = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0002_mail_drafts.sql'
INBOUND_FAX = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0007_inbound_fax_events.sql'

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

    def test_inbound_events_deduplicate(self):
        self.db.executescript(INBOUND_FAX.read_text())
        sql = 'INSERT INTO inbound_fax_events VALUES (?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING'
        self.db.execute(sql, ('event', 'fax', 'fax.received', 'then', 'now', 'private/key'))
        self.db.execute(sql, ('event', 'fax', 'fax.received', 'then', 'later', 'private/key'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM inbound_fax_events').fetchone()[0], 1)

    def test_migration_sequence_has_unique_prefixes(self):
        migrations = sorted(INBOUND_FAX.parent.glob('*.sql'))
        prefixes = [p.name.split('_', 1)[0] for p in migrations]
        self.assertEqual(len(prefixes), len(set(prefixes)))
        self.assertEqual(INBOUND_FAX.name, '0007_inbound_fax_events.sql')
        if '0004' in prefixes:
            self.assertIn('0004_mail_intents.sql', [p.name for p in migrations])
        if '0005' in prefixes:
            self.assertIn('0005_mail_unresolved_actor.sql', [p.name for p in migrations])
        if '0006' in prefixes:
            self.assertIn('0006_mail_acknowledgement.sql', [p.name for p in migrations])

if __name__ == '__main__':
    unittest.main()
