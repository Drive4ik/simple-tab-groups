const name = new URL(location.href).searchParams.get('tab') ?? '';

document.title = name;
document.getElementById('name').textContent = name;
