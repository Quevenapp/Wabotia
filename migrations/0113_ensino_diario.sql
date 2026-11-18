CREATE TABLE ensino_lessons (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL,
  date TEXT NOT NULL, starts TEXT NOT NULL, ends TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','held','cancelled')),
  PRIMARY KEY(profile_id,id), UNIQUE(profile_id,class_id,id),
  UNIQUE(profile_id,class_id,date,starts), CHECK(starts<ends),
  FOREIGN KEY(profile_id,class_id) REFERENCES ensino_classes(profile_id,id)
);
CREATE TABLE ensino_attendance (
  profile_id TEXT NOT NULL, class_id TEXT NOT NULL, lesson_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), status TEXT NOT NULL CHECK(status IN ('present','absent','justified')),
  reason TEXT NOT NULL CHECK(reason IN ('initial','correction')), actor_id TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,lesson_id,enrollment_id,revision),
  FOREIGN KEY(profile_id,class_id,lesson_id) REFERENCES ensino_lessons(profile_id,class_id,id),
  FOREIGN KEY(profile_id,class_id,enrollment_id) REFERENCES ensino_enrollments(profile_id,class_id,id)
);
CREATE TABLE ensino_assessments (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL, period_id TEXT NOT NULL,
  subject TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
  max_score REAL NOT NULL CHECK(max_score>0), weight REAL NOT NULL CHECK(weight>0),
  kind TEXT NOT NULL CHECK(kind IN ('regular','recovery')),
  PRIMARY KEY(profile_id,id), UNIQUE(profile_id,class_id,id),
  FOREIGN KEY(profile_id,class_id) REFERENCES ensino_classes(profile_id,id)
);
CREATE UNIQUE INDEX ensino_one_recovery ON ensino_assessments(profile_id,class_id,period_id,subject) WHERE kind='recovery';
CREATE INDEX ensino_assessments_period ON ensino_assessments(profile_id,class_id,period_id,id);
CREATE TABLE ensino_grades (
  profile_id TEXT NOT NULL, class_id TEXT NOT NULL, assessment_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), score REAL,
  status TEXT NOT NULL CHECK(status IN ('graded','absent','exempt')),
  reason TEXT NOT NULL CHECK(reason IN ('initial','correction')), actor_id TEXT NOT NULL, created INTEGER NOT NULL,
  CHECK((status='graded' AND score IS NOT NULL AND score>=0) OR (status<>'graded' AND score IS NULL)),
  PRIMARY KEY(profile_id,assessment_id,enrollment_id,revision),
  FOREIGN KEY(profile_id,class_id,assessment_id) REFERENCES ensino_assessments(profile_id,class_id,id),
  FOREIGN KEY(profile_id,class_id,enrollment_id) REFERENCES ensino_enrollments(profile_id,class_id,id)
);
CREATE TABLE ensino_reports (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
  period_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), class_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, published_by TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id), UNIQUE(profile_id,enrollment_id,period_id,revision),
  FOREIGN KEY(profile_id,class_id,enrollment_id) REFERENCES ensino_enrollments(profile_id,class_id,id)
);
