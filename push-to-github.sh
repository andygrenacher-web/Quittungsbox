#!/bin/bash
echo ""
echo "=== Quittungsbox → GitHub pushen ==="
echo ""
echo "Neuen Token eingeben (wird nicht angezeigt):"
read -rs TOKEN
echo ""

if [ -z "$TOKEN" ]; then
  echo "Kein Token eingegeben. Abbruch."
  exit 1
fi

echo "Pushe zu GitHub..."
git push "https://${TOKEN}@github.com/andygrenacher-web/Quittungsbox.git" main

if [ $? -eq 0 ]; then
  echo ""
  echo "✓ Erfolgreich! Jetzt auf GitHub Actions warten:"
  echo "  https://github.com/andygrenacher-web/Quittungsbox/actions"
else
  echo ""
  echo "✗ Fehler. Token ungültig oder abgelaufen?"
fi
