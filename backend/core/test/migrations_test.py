import pathlib
import sqlite3
import unittest

MIGRATION = pathlib.Path(__file__).resolve().parents[1] / 'migrations/0001_core.sql'

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

if __name__ == '__main__':
    unittest.main()
