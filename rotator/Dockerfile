FROM python:3.13-alpine

RUN adduser -D -u 10001 rotator
WORKDIR /app
COPY rotator.py .
USER rotator

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["python", "-u", "rotator.py"]
