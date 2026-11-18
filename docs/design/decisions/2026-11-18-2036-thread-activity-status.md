# Waiting status in a thread transcript

In the main thread and in a child thread, the activity line shows the time
spent on a finished run. Show a waiting badge when the run has an outstanding
question, is waiting for input, or has an explicit needs-input outcome. The
transcript uses actual run facts for this badge, independently of list grouping.
