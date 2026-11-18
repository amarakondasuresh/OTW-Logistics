# Admin Portal startup fix

The Windows launcher now opens the Admin Portal directly at `http://localhost:8080/dashboard/` after starting the backend, rather than opening only the public website. It also checks that Node.js 20 LTS or newer and npm are available before starting, because the backend's native SQLite dependency requires a supported Node.js runtime.

## Start
1. Extract the project ZIP completely.
2. Open the extracted `OTW-logistics` folder.
3. Double-click `START-WINDOWS.bat` (do not run it with the VS Code Code Runner extension).
4. Keep the black server window open.
5. The Admin Portal opens at `http://localhost:8080/dashboard/`.

## If it still does not open
- If the server window reports that port 8080 is already in use, stop the older OTW server window and run the launcher again.
- If dependency installation fails, install Node.js 20 LTS or newer, reconnect to the internet, and rerun the launcher.
- If the page loads but login fails, check the backend server window for the first-run admin credentials file at `backend/FIRST-ADMIN-PASSWORDS.txt`. Keep that file private and delete it after the admins have changed their temporary passwords.
- Do not delete `backend/payments.sqlite` when troubleshooting; it contains application data.
