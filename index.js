const {ObjectId} = require('mongodb');
const express = require('express');
const {MongoClient, ServerApiVersion} = require('mongodb');
const cors = require('cors');
const dotenv = require('dotenv');
const app = express();
const admin = require("firebase-admin");
dotenv.config();
const port = process.env.PORT || 3000;

const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);

app.use(cors());
app.use(express.json());


const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9c3lw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1, strict: true, deprecationErrors: true,
    }
});

async function run() {
    try {
        const db = client.db('parcelDB');
        const userCollection = db.collection('users');
        const parcelCollection = db.collection('parcels');
        const paymentCollection = db.collection('payments');
        const ridersCollection = db.collection('riders');

        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({message: 'Not authorized'});
            }
            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).send({message: 'Not authorized'});
            }

            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
            } catch (error) {
                return res.status(403).send({message: 'forbidden access'});
            }
            next()
        }

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = {email}
            const user = await userCollection.findOne(query)
            if(!user||user.role!=='admin') {
                return res.status(403).send({message: 'forbidden access'});
            }
            next();
        }


        app.post('/user', async (req, res) => {
            const email = req.body.email;
            const userExist = await userCollection.findOne({email});
            if (userExist) {
                return res.status(200).send({message: 'user already exists', inserted: false});
            }
            const user = req.body;
            const result = await userCollection.insertOne(user);
            res.send(result);
        })

        app.get('/users/search', async (req, res) => {
            try {
                const {q = ''} = req.query;          // text typed by admin

                if (!q.trim()) {                       // if search box is empty
                    return res.json([]);                 // return empty list
                }

                const users = await userCollection
                    .find({email: {$regex: q.trim(), $options: 'i'}},     // email contains q
                        {projection: {email: 1, role: 1, created_at: 1}})
                    .limit(20)                                            // at most 20 results
                    .toArray();

                res.json(users);
            } catch (err) {
                console.error(err);
                res.status(500).json({error: 'Search failed'});
            }
        });

        app.patch('/users/:id/role', verifyFBToken,verifyAdmin,async (req, res) => {
            try {
                const {id} = req.params;        // Mongo _id string
                const {role} = req.body;          // "admin" or "user"

                if (!['admin', 'user'].includes(role)) {
                    return res.status(400).json({error: 'role must be "admin" or "user"'});
                }

                const result = await userCollection.updateOne({_id: new ObjectId(id)},           // which user?
                    {$set: {role}}                   // set new role
                );

                if (result.modifiedCount === 1) {
                    res.json({message: `Role set to ${role}`});
                } else {
                    res.status(404).json({error: 'User not found'});
                }
            } catch (err) {
                console.error(err);
                res.status(500).json({error: 'Failed to update role'});
            }
        });

        /* ----------  GET /user/role?email=someone@example.com  ---------- *
   Response:
     200 → { role: "admin", name: "Alamin", photoURL: "..." }
     404 → { error: "User not found" }
     400 → { error: "Email query param required" }
*/
        app.get('/user/role', async (req, res) => {
            try {
                const email = req.query.email;
                if (!email) return res.status(400).json({error: 'Email query param required'});

                // Fetch only the fields we need
                const user = await userCollection.findOne({email}, {
                    projection: {
                        _id: 0,
                        role: 1,
                        name: 1,
                    }
                });

                if (!user) return res.status(404).json({error: 'User not found'});

                res.json(user);           // e.g. { role: "rider", name: "Alain", photoURL: "..." }
            } catch (err) {
                console.error('❌ Error getting role by email:', err);
                res.status(500).json({error: 'Failed to fetch user role'});
            }
        });

        app.get('/parcels', async (req, res) => {
            try {
                const filter = {};

                // Optional: filter by user e‑mail via createdBy field
                if (req.query.createdBy) {
                    filter.createdBy = req.query.createdBy;
                }

                // Fetch parcels sorted by createdAtISO (latest first)
                const parcels = await parcelCollection
                    .find(filter)
                    .sort({createdAtISO: -1})  // ISO strings sort chronologically
                    .toArray();

                res.json(parcels);
            } catch (err) {
                console.error('❌ Error fetching parcels:', err);
                res.status(500).json({error: 'Failed to fetch parcel data.'});
            }
        });


        /* ────────────────────────────────────────────────
   GET /parcels/unassigned
   Returns parcels that are paid but not yet collected
   ──────────────────────────────────────────────── */
        app.get('/parcels/unassigned', async (req, res) => {
            try {
                const filter = {
                    deliveryStatus: 'Not Collected',
                    paymentStatus:  'Paid'
                };

                const parcels = await parcelCollection
                    .find(filter)
                    .sort({ createdAtISO: -1 })   // newest first
                    .toArray();

                res.json(parcels);
            } catch (err) {
                console.error('❌ Error fetching unassigned parcels:', err);
                res.status(500).json({ error: 'Failed to load unassigned parcels.' });
            }
        });


        /* ----------  POST a new parcel  ---------- */
        app.post('/parcels', async (req, res) => {
            try {
                /* 1️⃣  Basic validation */
                const required = [
                    'type','title',
                    'senderName','senderContact','senderEmail','senderRegion','senderCenter','senderAddress','pickupInstruction',
                    'receiverName','receiverContact','receiverRegion','receiverCenter','receiverAddress','deliveryInstruction',
                    'createdBy','cost'
                ];
                const missing = required.filter(k => !req.body?.[k]);
                if (missing.length) {
                    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
                }

                /* 2️⃣  Server‑trusted timestamps + default status */
                const now = Date.now(); // Unix (ms)
                const parcelDoc = {
                    ...req.body,
                    deliveryStatus: 'Not Collected',       // ✅ NEW default field
                    createdAtUnix: now,
                    createdAtISO: new Date(now).toISOString()
                };

                /* 3️⃣ Save to MongoDB */
                const result = await parcelCollection.insertOne(parcelDoc);

                /* 4️⃣  Respond */
                res.status(201).json({
                    message: 'Parcel saved successfully.',
                    insertedId: result.insertedId
                });
            } catch (err) {
                console.error('❌ Failed to save parcel:', err);
                res.status(500).json({ error: 'Something went wrong while saving the parcel.' });
            }
        });


        /* ---------- GET /parcels — all or by user, sorted by ISO date ---------- */

        app.get('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;
                // 2️⃣ Query MongoDB by _id
                const parcel = await parcelCollection.findOne({_id: new ObjectId(id)});

                // 3️⃣ Handle not found
                if (!parcel) {
                    return res.status(404).json({error: 'Parcel not found.'});
                }

                // 4️⃣ Success
                res.json(parcel);
            } catch (err) {
                console.error('❌ Error fetching parcel by ID:', err);
                res.status(500).json({error: 'Failed to fetch parcel.'});
            }
        });

        app.delete('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;

                // Validate ObjectId
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({error: 'Invalid parcel ID.'});
                }

                const result = await parcelCollection.deleteOne({_id: new ObjectId(id)});

                if (result.deletedCount === 0) {
                    return res.status(404).json({error: 'Parcel not found.'});
                }

                res.json({message: 'Parcel deleted successfully.'});
            } catch (err) {
                console.error('❌ Error deleting parcel:', err);
                res.status(500).json({error: 'Failed to delete parcel.'});
            }
        });


        app.post('/riders', async (req, res) => {
            const rider = req.body;
            const result = await ridersCollection.insertOne(rider)
            res.send(result);
        })

        app.patch('/riders/:id', async (req, res) => {
            await ridersCollection.updateOne({_id: new ObjectId(req.params.id)}, {$set: {status: req.body.status}});
            res.json({ok: true});
        });

        // GET /riders/pending
        app.get('/riders/pending',verifyFBToken,verifyAdmin, async (req, res) => {
            try {
                const pendingRiders = await ridersCollection
                    .find({status: 'pending'})
                    .toArray();

                res.json(pendingRiders);
            } catch (error) {
                console.error('Error fetching pending riders:', error);
                res.status(500).json({error: 'Failed to load pending rider applications'});
            }
        });

        // Assuming you're using Express and have connected to MongoDB
        app.get('/riders/active',verifyFBToken,verifyAdmin, async (req, res) => {
            try {
                const activeRiders = await db.collection('riders')
                    .find({status: 'approved'})
                    .toArray();

                res.json(activeRiders);
            } catch (err) {
                console.error('❌ Error loading active riders:', err);
                res.status(500).json({error: 'Failed to fetch active riders'});
            }
        });


        /* -------------------------------------------
   PATCH /parcels/:id/assign
   body: { riderId: "64e1..." }
   ------------------------------------------- */
        /* -------------------------------------------
    PATCH /parcels/:id/assign
    body: { riderId: "64e1..." }
    ------------------------------------------- */
        app.patch('/parcels/:id/assign', async (req, res) => {
            try {
                const parcelId = req.params.id;
                const { riderId } = req.body;

                if (!riderId) return res.status(400).json({ error: 'riderId is required' });

                /* 1️⃣  confirm rider exists & approved */
                const rider = await ridersCollection.findOne({
                    _id: new ObjectId(riderId),
                    status: 'approved'
                });
                if (!rider) return res.status(404).json({ error: 'Rider not found or not approved' });

                const now = Date.now();

                /* 2️⃣  update parcel  (deliveryStatus → in‑transit) */
                const parcelRes = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            assignedRiderId: new ObjectId(riderId),
                            deliveryStatus:  'in-transit',          // 🔸 NEW value
                            assignedAtISO:   new Date(now).toISOString(),
                            assignedAtUnix:  now
                        }
                    }
                );
                if (parcelRes.modifiedCount !== 1)
                    return res.status(404).json({ error: 'Parcel not found or already assigned' });

                /* 3️⃣  update rider  (workStatus → in‑delivery) */
                await ridersCollection.updateOne(
                    { _id: new ObjectId(riderId) },
                    { $set: { workStatus: 'in-delivery' } }     // 🔸 NEW field
                );

                res.json({ message: 'Rider assigned and parcel marked in‑transit' });
            } catch (err) {
                console.error('❌ Error assigning rider:', err);
                res.status(500).json({ error: 'Failed to assign rider' });
            }
        });



        // riders status
        app.patch('/riders/:id/status', async (req, res) => {
            try {
                const {id} = req.params;
                const {status, email} = req.body;
                if (!status) return res.status(400).json({error: 'Status required'});

                const result = await ridersCollection.updateOne({_id: new ObjectId(id)}, {$set: {status}});

                /* promote user role if rider is approved */
                if (status === 'approved' && email) {
                    await userCollection.updateOne({email}, {$set: {role: 'rider'}});
                }

                if (result.modifiedCount === 1) {
                    res.json({message: 'Status updated'});

                } else {
                    res.status(404).json({error: 'Rider not found or already updated'});
                }
            } catch (err) {
                console.error(err);
                res.status(500).json({error: 'Failed to update rider status'});
            }
        });

        app.post('/payments', async (req, res) => {
            try {
                const {parcelId, amount, paymentMethod, transactionId} = req.body;

                if (!ObjectId.isValid(parcelId)) {
                    return res.status(400).json({error: 'Invalid parcelId.'});
                }

                // ✅ Fetch parcel to get user info (createdBy)
                const parcel = await parcelCollection.findOne({_id: new ObjectId(parcelId)});
                if (!parcel) return res.status(404).json({error: 'Parcel not found.'});

                if (parcel.paymentStatus === 'Paid') {
                    return res.status(409).json({error: 'Parcel already marked as Paid.'});
                }

                const now = Date.now();
                const paymentDoc = {
                    parcelId: new ObjectId(parcelId),
                    amount,
                    paymentMethod,
                    txId: transactionId || null,
                    status: 'Paid',
                    createdAtISO: new Date(now).toISOString(),
                    createdAtUnix: now,
                    createdBy: parcel.createdBy || null   // ✅ ADD THIS LINE
                };

                const payResult = await paymentCollection.insertOne(paymentDoc);

                await parcelCollection.updateOne({_id: new ObjectId(parcelId)}, {
                    $set: {
                        paymentStatus: 'Paid',
                        paymentAtISO: paymentDoc.createdAtISO,
                        paymentAtUnix: paymentDoc.createdAtUnix,
                        paymentId: payResult.insertedId
                    }
                });

                res.status(201).json({
                    message: 'Payment recorded & parcel marked as Paid.', paymentId: payResult.insertedId
                });

            } catch (err) {
                console.error('❌ Error posting payment:', err);
                res.status(500).json({error: 'Failed to record payment.'});
            }
        });


        app.get('/payments', verifyFBToken, async (req, res) => {
            try {
                const filter = {};
                if (req.query.createdBy) filter.createdBy = req.query.createdBy;

                const payments = await paymentCollection
                    .find(filter)
                    .sort({createdAtISO: -1})    // newest → oldest
                    .toArray();

                res.json(payments);
            } catch (err) {
                console.error('❌ Error fetching payments:', err);
                res.status(500).json({error: 'Failed to load payment history.'});
            }
        });

        app.post('/create-payment-intent', async (req, res) => {
            const amountInCents = req.body.amountInCents;
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents, currency: 'usd', payment_method_types: ['card'],
                });
                res.json({clientSecret: paymentIntent.client_secret});
            } catch (err) {
                res.status(500).json({error: err.message});
            }
        })

        await client.db("admin").command({ping: 1});
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
    }
}

run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('zap shift server-side');
})

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
})