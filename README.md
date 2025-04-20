# O2CM Event Parsing Script
Parse event heat sheets from O2CM competitors list.


To run, first install nodejs >14.0 on your system (https://nodejs.org/en/download). After installing, run `node ./index.mjs` in this directory to run the script. It will prompt you for an event ID (e.g CCC), parse all the competitors, and aggregate them by events for easy viewing. It will create a file `events.txt` storing the results so you don't need to wait for the script to run again if you lose the output. 