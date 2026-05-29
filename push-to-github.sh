#!/bin/bash
echo ""
echo "=== Quittungsbox → GitHub pushen ==="
echo ""
echo "Token eingeben (wird nicht angezeigt):"
read -rs TOKEN
echo ""

if [ -z "$TOKEN" ]; then
  echo "Kein Token eingegeben. Abbruch."
  exit 1
fi

git remote set-url origin "https://${TOKEN}@github.com/andygrenacher-web/Quittungsbox.git"

echo "Pushe zu GitHub..."
git push -u origin main

echo ""
echo "Fertig! Jetzt auf github.com/andygrenacher-web/Quittungsbox den Tab 'Actions' öffnen."
